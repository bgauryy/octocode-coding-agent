import { getFileStamp } from "../../../../common/src/paths.ts";
import { readFileSync, statSync } from "node:fs";
import {
	type FileStamp,
	type MirrorRecord,
	type MirrorWorkspace,
	type TranscriptCommand,
	type TranscriptResult,
	transcripts as storedTranscripts,
	writerErrorKind,
} from "../../../../db/src/api.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { sharedAgentDb, sharedTranscriptWriter } from "../../storage/database.ts";
import { readWorkspaceIdentity, workspaceIdentity } from "../../storage/workspace.ts";
import { workspaceGit } from "../../utils/git-repository.ts";
import { encodeSessionLines, SessionCodec } from "./codec.ts";
import { recordLines } from "./mirror-lines.ts";
import type { SessionState } from "./state.ts";
import { READER_LOCK_WAIT_MS, withSessionFileLock } from "./shared-file.ts";

/**
 * How the session mirror reaches the database writer (`mirror.ts` is its API). The session file is the record and is
 * written first, under its lock; every mirror write is a typed command for the database writer (`db/src/writer/`), which
 * runs it on its own thread and connection, in submission order. Records travel as the JSON text the file holds, so the
 * copy cannot differ from the file. A missed or failed write leaves the mirror behind; the next command finds it `stale`
 * and a rebuild from a consistent snapshot repairs it, as the next open does. Repairs follow the transcript (session id
 * and file), not the session the state shows now: a reply that arrives after `/new` or `/resume` still repairs its own.
 */

let noticeHandler: ((message: string) => void) | undefined;

export function setNoticeHandler(handler: ((message: string) => void) | undefined): void {
	noticeHandler = handler;
}

export const currentNoticeHandler = () => noticeHandler;

export function notify(message: string): void {
	if (noticeHandler) noticeHandler(message);
	else process.stderr.write(`${message}\n`);
}

/**
 * The wait before an append tries another full rebuild after one failed, doubling up to the last. A rebuild sends the
 * whole transcript to the database writer, and the JSONL is already safe, so a database that stays busy must not cost
 * that on every append. An open or a replace still tries at once.
 */
const REBUILD_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/** Longest a refused write waits for the writer's queue to drain before it tries again. */
export const QUEUE_RETRY_WAIT_MS = 30_000;

/** What asked for a mirror write: only an append waits out the rebuild backoff. */
export type Origin = "open" | "append" | "replace";

/** One transcript's mirror: what failed, the rebuild backoff, and the newest full save sent. */
export interface Transcript {
	readonly sessionId: string;
	/** Canonical path of the session file. */
	readonly file: string;
	readonly cwd: string;
	/** The state that last wrote it, and that state's file then: while both still hold, its entries are this file's. */
	state: SessionState;
	stateFile: string | undefined;
	problem?: string;
	rebuild?: { notBefore: number; failures: number };
	saved?: number;
	/** The sequence of the last command that continued the mirror from its stored rows (`continueMirror`). */
	continued?: number;
	/** That command found the mirror moved meanwhile: the next rebuild saves everything. */
	fullNext?: boolean;
	pending: number;
	waitingForRoom: boolean;
}

const transcripts = new Map<string, Transcript>();

export function transcriptOf(state: SessionState, file: string): Transcript {
	const key = `${state.sessionId}\n${file}`;
	let transcript = transcripts.get(key);
	if (!transcript) {
		const cwd = state.cwd;
		transcript = {
			sessionId: state.sessionId,
			file,
			cwd,
			state,
			stateFile: state.sessionFile,
			pending: 0,
			waitingForRoom: false,
		};
		transcripts.set(key, transcript);
	}
	transcript.state = state;
	transcript.stateFile = state.sessionFile;
	return transcript;
}

const attached = (t: Transcript) =>
	t.state.sessionId === t.sessionId && t.stateFile !== undefined && t.state.sessionFile === t.stateFile;

/** Forget a transcript with nothing in flight that no state shows, or that has nothing to repair. */
function release(t: Transcript): void {
	if (t.pending > 0 || t.waitingForRoom) return;
	if (!attached(t) || (t.problem === undefined && t.rebuild === undefined))
		transcripts.delete(`${t.sessionId}\n${t.file}`);
}

export const inflight = new Set<Promise<void>>();
let sequence = 0;

export function track(operation: Promise<void>): void {
	inflight.add(operation);
	void operation.finally(() => inflight.delete(operation));
}

/** A record as the file holds it: `json` is the line without its newline. */
export function row(record: { id?: unknown; parentId?: unknown; type?: unknown }, json: string): MirrorRecord {
	return {
		id: String(record.id),
		parentId: typeof record.parentId === "string" ? record.parentId : null,
		type: String(record.type),
		json,
	};
}

/** Appends of one transcript not sent yet: a chain whose every append started where the one before it ended. */
export interface Batch {
	header: string;
	previous: { size: number; mtime: string };
	stamp: FileStamp;
	entries: { position: number; record: MirrorRecord }[];
}

export const batches = new Map<Transcript, Batch>();

/** Send every waiting append: before any other mirror command, so the queue keeps the order the file has. */
export function flushAll(): void {
	for (const [t, batch] of batches) {
		batches.delete(t);
		try {
			send(t, "append", {
				kind: "sync",
				sessionId: t.sessionId,
				file: t.file,
				stamp: batch.stamp,
				previous: batch.previous,
				header: batch.header,
				entries: batch.entries,
				workspace: mirrorWorkspace(t.cwd, true),
			});
		} catch (error) {
			problem(t, error, false);
		}
	}
}

/** Rebuild from a snapshot whose records and stamp agree, unless an append is still inside the rebuild backoff. */
export function rebuild(t: Transcript, origin: Origin): void {
	if (origin === "append" && Date.now() < (t.rebuild?.notBefore ?? 0)) return;
	let snapshot: { stamp: FileStamp; records: readonly unknown[]; lines?: readonly string[] };
	try {
		const stamp = getFileStamp(t.file);
		const state = t.state;
		// Unchanged since this state's last write, with nothing held back: the entries in memory are the file. An open
		// (whose entries may have been read before its size was taken), another writer's records, or a state that moved
		// on to another session: read the file while no one appends, and parse it once the lock is released.
		if (origin !== "open" && attached(t) && stamp.size === state.fileSize && state.unwritten.length === 0) {
			if (continueMirror(t, stamp, state.fileEntries)) return;
			snapshot = { stamp, records: state.fileEntries };
		} else {
			const read = withSessionFileLock(
				t.file,
				() => {
					const taken = getFileStamp(t.file);
					const bytes = readFileSync(t.file);
					// The stamp describes exactly these bytes, or the rebuild waits for the next try.
					if (bytes.length !== taken.size) throw new Error("Session file changed while it was read");
					return { stamp: taken, bytes };
				},
				READER_LOCK_WAIT_MS,
			);
			snapshot = { stamp: read.stamp, ...fileRecords(read.bytes) };
		}
	} catch (error) {
		problem(t, error, true);
		return;
	}
	save(t, origin, snapshot.stamp, snapshot.records, snapshot.lines);
}

/**
 * Continue a mirror that holds a prefix of this file: store only the records past its last stored row, as appends do,
 * instead of encoding the whole transcript again. Only when the stored rows end with the entry `records` holds at that
 * position, under this file's identity and below its size; the writer still adds them only while the mirror is level
 * with the stamp read here. False: save everything.
 */
function continueMirror(t: Transcript, stamp: FileStamp, records: readonly unknown[]): boolean {
	if (t.fullNext) {
		t.fullNext = false;
		return false;
	}
	// Appends still waiting go first (a full save sends them): the stored rows read now would not include them.
	if (batches.has(t)) return false;
	let tail: ReturnType<typeof storedTranscripts.storedTail>;
	try {
		tail = storedTranscripts.storedTail(sharedAgentDb().mirror.db, t.sessionId);
	} catch {
		return false;
	}
	const saved = tail.stamp;
	const from = tail.stored;
	if (!saved || saved.file !== t.file || saved.file_binding !== stamp.binding || saved.byte_size >= stamp.size)
		return false;
	// `records[0]` is the header; the entry at stored position `p` is `records[p + 1]`.
	if (from === 0 || from + 1 >= records.length || (records[from] as { id?: unknown }).id !== tail.lastId) return false;
	const codec = new SessionCodec();
	const header = JSON.stringify(codec.encode(records[0] as object));
	for (let i = 0; i <= from; i++) codec.observe(records[i] as object);
	const entries: Batch["entries"] = [];
	for (let i = from + 1; i < records.length; i++) {
		const record = records[i] as object;
		entries.push({ position: i - 1, record: row(record, JSON.stringify(codec.encode(record))) });
		codec.observe(record);
	}
	sendContinuation(t, "append", {
		kind: "sync",
		sessionId: t.sessionId,
		file: t.file,
		stamp,
		previous: { size: saved.byte_size, mtime: saved.mtime },
		header,
		entries,
		workspace: mirrorWorkspace(t.cwd, true),
	});
	return true;
}

/**
 * Send rows that continue the stored mirror from its saved stamp: a repair as a save is, and when the writer finds the
 * mirror moved meanwhile (`stale`), the rebuild that follows saves everything.
 */
export function sendContinuation(
	t: Transcript,
	origin: Origin,
	command: Extract<TranscriptCommand, { kind: "sync" }>,
): void {
	send(t, origin, command, true);
	t.continued = sequence;
}

/**
 * The records of a session file's bytes, each with the line that holds it, as `loadEntriesFromFile` reads them: blank,
 * malformed and `null` lines are skipped, and a file whose first record is not a session header has none.
 */
function fileRecords(bytes: Buffer): { records: unknown[]; lines: string[] } {
	const { records, lines } = recordLines(bytes);
	const header = records[0] as { type?: unknown; id?: unknown } | undefined;
	return header?.type === "session" && typeof header.id === "string" ? { records, lines } : { records: [], lines: [] };
}

/**
 * Send a full save of `records`. `lines`: each record's line in the file, sent as is (a file read already holds them);
 * without them the records are stored as the file writer stores them.
 */
export function save(
	t: Transcript,
	origin: Origin,
	stamp: FileStamp,
	records: readonly unknown[],
	lines?: readonly string[],
): void {
	// Appends still waiting were written before this snapshot: they go first, or their reply would ask for a rebuild.
	flushAll();
	try {
		const header = records[0] as { type?: unknown; id?: unknown } | undefined;
		if (header?.type !== "session" || header.id !== t.sessionId) throw new Error("Session file identity changed");
		// A full queue would refuse the command: do not serialize the transcript for nothing, rebuild once it drains.
		if (!sharedTranscriptWriter().canAccept()) {
			problem(t, new Error("Database writer queue is full"), false);
			retryWhenFree(t);
			return;
		}
		// Whole entries are stored as the file writer stores them (`codec.ts`), so the copy matches the file.
		const stored = lines ?? encodeSessionLines(records as object[]).lines;
		send(t, origin, {
			kind: "save",
			sessionId: t.sessionId,
			file: t.file,
			stamp,
			header: stored[0],
			records: records.slice(1).map((record, index) => row(record as Partial<MirrorRecord>, stored[index + 1])),
			workspace: mirrorWorkspace(t.cwd, origin !== "open"),
		});
	} catch (error) {
		problem(t, error, true);
	}
}

/** `repair`: a command that brings the whole mirror level (a continuation, `continueMirror`), as a save does. */
export function send(
	t: Transcript,
	origin: Origin,
	command: Extract<TranscriptCommand, { sessionId: string }>,
	repair = false,
): void {
	if (origin !== "append") flushAll();
	const seq = ++sequence;
	const full = command.kind === "save" || repair;
	if (full) t.saved = seq;
	t.pending += 1;
	track(
		sharedTranscriptWriter()
			.submit(command)
			.then(
				(result) => replied(t, origin, seq, result),
				(error: unknown) => {
					if (queueFull(error)) {
						problem(t, error, false);
						retryWhenFree(t);
						return;
					}
					problem(t, error, full);
					// No later append of this state will find a transcript it no longer shows behind: repair it now.
					if (!full && !attached(t)) rebuild(t, "append");
				},
			)
			.finally(() => {
				t.pending -= 1;
				release(t);
			}),
	);
}

function replied(t: Transcript, origin: Origin, seq: number, result: TranscriptResult): void {
	if (result === "saved" || result === "current") {
		t.problem = undefined;
		t.rebuild = undefined;
	} else if (result === "stale") {
		// A repair sent after this command already covers it. A continuation (`continueMirror`) that found the mirror
		// moved is itself the newest repair: the next one saves everything.
		const continued = seq === t.continued;
		if ((t.saved ?? 0) < seq || (continued && t.saved === seq)) {
			if (continued) t.fullNext = true;
			rebuild(t, origin);
		}
	}
}

export const queueFull = (error: unknown) => writerErrorKind(error) === "queue-full";

/** Wait for the writer to drain, then rebuild once: the commands the full queue refused are behind. */
function retryWhenFree(t: Transcript): void {
	if (t.waitingForRoom) return;
	t.waitingForRoom = true;
	track(
		sharedTranscriptWriter()
			.drain(QUEUE_RETRY_WAIT_MS)
			.then(() => {
				t.waitingForRoom = false;
				rebuild(t, "replace");
				release(t);
			}),
	);
}

/** Report a pending mirror once per distinct problem; a failed full save waits before an append tries the next. */
export function problem(t: Transcript, error: unknown, full: boolean): void {
	const message = errorMessage(error);
	if (t.problem !== message) notify(`Session saved to ${t.file}. Database mirror pending: ${message}`);
	t.problem = message;
	if (full) {
		const failures = (t.rebuild?.failures ?? 0) + 1;
		const wait = REBUILD_BACKOFF_MS[Math.min(failures, REBUILD_BACKOFF_MS.length) - 1];
		t.rebuild = { notBefore: Date.now() + wait, failures };
	}
}

/**
 * The transcript's workspace. Opening an imported transcript can resolve an existing declaration but must never create
 * one at its header cwd; a write in a folder without one declares it.
 */
export function mirrorWorkspace(cwd: string, declare: boolean): MirrorWorkspace | null {
	const identity =
		readWorkspaceIdentity(cwd) ??
		(declare && statSync(cwd, { throwIfNoEntry: false })?.isDirectory() ? workspaceIdentity(cwd) : undefined);
	return identity ? { ...identity, git: workspaceGit(identity.root) } : null;
}
