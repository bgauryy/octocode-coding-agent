import { getFileStamp } from "@octocodeai/octocode-common/paths";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { type FileStamp, type TranscriptCommand, transcripts, writerErrorKind } from "../../../../db/src/api.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { sharedAgentDb, sharedTranscriptWriter } from "../../storage/database.ts";
import { workspaceIdentity } from "../../storage/workspace.ts";
import { workspaceGit } from "../../utils/git-repository.ts";
import type { SessionState } from "./state.ts";
import type { SessionEntry } from "./types.ts";
import {
	batches,
	currentNoticeHandler,
	flushAll,
	inflight,
	mirrorWorkspace,
	notify,
	problem,
	QUEUE_RETRY_WAIT_MS,
	queueFull,
	rebuild,
	row,
	save,
	send,
	setNoticeHandler,
	track,
	transcriptOf,
} from "./mirror-writes.ts";
import { continueOpenedMirror } from "./mirror-open.ts";
import { strictJsonLine } from "./json-line.ts";
import { mirrorsSessionFile } from "./mirror-scope.ts";

/**
 * The session's database mirror: header and entries copied to the agent database after the session file, by the
 * database writer (`mirror-writes.ts` sends the commands). The file stays the record; the copy follows within
 * milliseconds, and a reader that needs it level awaits `sessionMirrorSettled`.
 */

/**
 * Where a mirror problem is reported. Without a handler it goes to stderr; a full-screen UI sets one so the text does
 * not print over the screen. Returns the function that removes the handler.
 */
export function setMirrorNoticeHandler(handler: (message: string) => void): () => void {
	setNoticeHandler(handler);
	return () => {
		if (currentNoticeHandler() === handler) setNoticeHandler(undefined);
	};
}

/**
 * Wait until every mirror write sent so far (and the rebuilds and retries their replies asked for) is acknowledged, at
 * most `timeoutMs`; false when some are still out. A reader that needs this session's rows level with its file, and a
 * process about to exit, await this.
 */
export async function sessionMirrorSettled(timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	flushAll();
	while (inflight.size > 0) {
		const left = deadline - Date.now();
		if (left <= 0) return false;
		let timer: NodeJS.Timeout | undefined;
		const timedOut = await Promise.race([
			Promise.allSettled(inflight).then(() => false),
			// Not unref'd: whoever awaits this keeps the process for its bound, as the writers alone would not.
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(true), left);
			}),
		]);
		clearTimeout(timer);
		if (timedOut) return false;
	}
	return true;
}

/**
 * The file was just opened: rebuild the mirror now when it is behind, so a fork made right after finds its parent. The
 * check is one read (it does not wait for writers); the rebuild itself goes to the writer. A current mirror still has its
 * workspace checked there.
 */
export function mirrorOpened(state: SessionState, sessionFile: string): void {
	const file = canonicalPath(sessionFile);
	if (!mirrorsSessionFile(file, state)) return;
	const t = transcriptOf(state, file);
	try {
		const stamp = getFileStamp(t.file);
		if (!mirrorLevel(t.sessionId, t.file, stamp)) {
			// Behind by lines appended after a stored prefix: only they are sent. Anything else rebuilds from the file.
			if (!continueOpenedMirror(t, stamp)) rebuild(t, "open");
			return;
		}
		send(t, "open", {
			kind: "sync",
			sessionId: t.sessionId,
			file: t.file,
			stamp,
			workspace: mirrorWorkspace(t.cwd, false),
		});
	} catch (error) {
		problem(t, error, false);
	}
}

/** Whether the saved stamp matches the file; false also when the database cannot be read (the rebuild reports why). */
function mirrorLevel(sessionId: string, file: string, stamp: FileStamp): boolean {
	let saved: ReturnType<typeof transcripts.stamp>;
	try {
		saved = transcripts.stamp(sharedAgentDb().mirror.db, sessionId);
	} catch {
		return false;
	}
	return (
		saved?.file === file &&
		saved.byte_size === stamp.size &&
		saved.mtime === stamp.mtime &&
		saved.file_binding === stamp.binding
	);
}

/**
 * The whole file was just written under its lock and `stamp` taken right after: save every record. `lines`, when the
 * writer has them, are the file's lines in record order (without newlines), so the records are not serialized again.
 */
export function mirrorReplaced(
	state: SessionState,
	sessionFile: string,
	stamp: FileStamp,
	lines?: readonly string[],
): void {
	const file = canonicalPath(sessionFile);
	if (mirrorsSessionFile(file, state)) save(transcriptOf(state, file), "replace", stamp, state.fileEntries, lines);
}

/**
 * `written` entries were just appended under the file lock, each as `line`, to a file that stood at `previous`, leaving
 * it at `stamp`. Appends made in one turn of the event loop that continue each other go as one command after it (the
 * newest revision covers the rest), so a burst of appends costs one command, not one each. Their rows are added when the
 * mirror was level with the first `previous`; otherwise the reply says `stale` and a rebuild follows.
 */
export function mirrorAppended(
	state: SessionState,
	sessionFile: string,
	previous: { size: number; mtime: string },
	written: readonly { entry: SessionEntry; line: string }[],
	stamp: FileStamp,
): void {
	const file = canonicalPath(sessionFile);
	if (written.length === 0 || !mirrorsSessionFile(file, state)) return;
	const t = transcriptOf(state, file);
	// Its index among the entries, past the header (not always the last: held entries are written in a row).
	const rows = written.map(({ entry, line }) => ({
		position: state.fileEntries.lastIndexOf(entry) - 1,
		record: row(entry, line.endsWith("\n") ? line.slice(0, -1) : line),
	}));
	const batch = batches.get(t);
	if (
		batch &&
		batch.stamp.binding === stamp.binding &&
		batch.stamp.size === previous.size &&
		batch.stamp.mtime === previous.mtime
	) {
		batch.stamp = stamp;
		batch.entries.push(...rows);
		return;
	}
	if (batch) flushAll();
	const wasEmpty = batches.size === 0;
	batches.set(t, { header: strictJsonLine(state.fileEntries[0]), previous, stamp, entries: rows });
	if (wasEmpty) queueMicrotask(flushAll);
}

/** Tries of a fork edge: it has no rebuild of its own, so a refused or lost write is sent again. */
const FORK_ATTEMPTS = 3;

/** Call only for an explicitly created fork, never for parentSession data loaded from a transcript file. */
export function recordFork(
	cwd: string,
	id: string,
	file: string,
	source: { file: string; expectedId?: string } | { storedId: string },
): void {
	const failed = (error: unknown) => notify(`Could not record the fork origin for ${id}: ${errorMessage(error)}`);
	let command: TranscriptCommand;
	try {
		const identity = workspaceIdentity(cwd);
		command = {
			kind: "fork",
			child: id,
			childFile: canonicalPath(file),
			parent: "storedId" in source ? source : { file: canonicalPath(source.file), expectedId: source.expectedId },
			workspace: { ...identity, git: workspaceGit(identity.root) },
		};
	} catch (error) {
		failed(error);
		return;
	}
	const attempt = (tries: number): void => {
		// The same queue as the parent's mirror writes, sent after them, so a parent saved just before is found.
		flushAll();
		const writer = sharedTranscriptWriter();
		track(
			writer.submit(command).then(
				() => undefined,
				async (error: unknown) => {
					if (tries >= FORK_ATTEMPTS || !retryable(error)) return failed(error);
					if (queueFull(error)) await writer.drain(QUEUE_RETRY_WAIT_MS);
					attempt(tries + 1);
				},
			),
		);
	};
	attempt(1);
}

/** A full queue, a writer that stopped before acknowledging, or a database held past the wait: worth another try. */
function retryable(error: unknown): boolean {
	const kind = writerErrorKind(error);
	return kind === "queue-full" || kind === "unavailable" || kind === "db-busy";
}
