import fs from "node:fs";
import { getFileStamp } from "../../../common/src/paths.ts";
import { parseJsonlLine } from "../../../common/src/jsonl.ts";
import { bindingKey } from "../binding.ts";
import type { AgentDb } from "../db.ts";
import * as forks from "../queries/forks.ts";
import * as sessions from "../queries/sessions.ts";
import * as transcripts from "../queries/transcripts.ts";
import * as workspaces from "../queries/workspaces.ts";
import { planSave, type SaveSteps, startSave } from "./transcript-save.ts";

/**
 * The session-mirror commands the database writer runs (`client.ts`, `worker.ts`). The session file is the record; these
 * rows are a derived copy in the transcript mirror file (`agent.mirror`). The session's workspace binding and fork edges
 * are coordination rows (`agent.db`), written in a coordination transaction nested inside the mirror's (the mirror's lock
 * first, always). Commands carry records with their original stamp, or ask this worker to read a file snapshot whose
 * identity, size and mtime stay unchanged during the read. A stored stamp never gets ahead of its stored entries.
 */

/** `size` in bytes, `mtime` in nanoseconds and `binding` (`ino:birth`) of a session file, as `getFileStamp` returns them. */
export interface FileStamp {
	size: number;
	mtime: string;
	binding: string;
}

/** The workspace a transcript belongs to, resolved by the host; null when its folder has none (an opened import). */
export type MirrorWorkspace = workspaces.WorkspaceIdentity & { git?: workspaces.WorkspaceGit | null };

/**
 * A transcript entry with its tree edge and `json`, the line the session file holds (without its newline). The host
 * serializes it once, as the file writer does, so the copy cannot differ from the file and nothing unclonable is sent.
 */
export type MirrorRecord = transcripts.EntryRow;

interface TranscriptTarget {
	sessionId: string;
	/** Canonical path of the session file. */
	file: string;
	workspace: MirrorWorkspace | null;
}

export type TranscriptCommand =
	| (TranscriptTarget & {
			/** Without `entries`: is the mirror level with `stamp`? With them: append them when it is level with `previous`. */
			kind: "sync";
			stamp: FileStamp;
			previous?: { size: number; mtime: string };
			/** The header line, as the file holds it. */
			header?: string;
			/** Appended entries and their position among the entries (past the header). */
			entries?: { position: number; record: MirrorRecord }[];
	  })
	| (TranscriptTarget & { kind: "save"; stamp: FileStamp; header: string; records: MirrorRecord[] })
	| (TranscriptTarget & { kind: "save-file"; binding: string })
	| {
			kind: "fork";
			child: string;
			childFile: string;
			parent: { file: string; expectedId?: string } | { storedId: string };
			workspace: MirrorWorkspace;
	  };

/**
 * `saved` committed rows; `current` found the mirror level; `stale` found it behind (the caller rebuilds it from a
 * snapshot); `skipped` wrote nothing because the file is gone or was replaced, or the fork has no recorded parent.
 */
export type TranscriptResult = "saved" | "current" | "stale" | "skipped";

/**
 * Run one command as one transaction of the mirror (with a nested coordination one for the session's workspace); a
 * `save` writes only what differs from the stored rows, and with `steps` a large difference goes in several bounded
 * transactions (`transcript-save.ts`). Throws what the caller reports as a pending mirror.
 */
export function runTranscriptCommand(agent: AgentDb, command: TranscriptCommand, steps?: SaveSteps): TranscriptResult {
	if (command.kind === "save-file") {
		const snapshot = readSnapshot(command);
		return snapshot ? runTranscriptCommand(agent, snapshot, steps) : "skipped";
	}
	const mirror = agent.mirror;
	if (command.kind === "fork") return agent.transaction(() => linkFork(agent, command));
	// Read before the write lock: comparing a large transcript must not hold other writers.
	const plan = command.kind === "save" ? planSave(mirror, command) : undefined;
	let rest: (() => TranscriptResult) | undefined;
	const result = mirror.transaction((): TranscriptResult => {
		const previous = transcripts.stamp(mirror.db, command.sessionId);
		// The workspace a stored transcript's session is bound to: a transcript bound to another one is refused.
		const bound = () => (previous ? sessions.byId(agent.db, command.sessionId)?.workspace_id : undefined);
		const level =
			previous?.file === command.file &&
			previous.file_binding === bindingKey(command.stamp.binding) &&
			(command.kind === "sync" && command.entries
				? previous.byte_size === command.previous?.size && previous.mtime === command.previous.mtime
				: previous.byte_size === command.stamp.size && previous.mtime === command.stamp.mtime);
		if (command.kind === "sync" && !command.entries) {
			if (!level) return "stale";
			agent.transaction(() => claimWorkspace(agent, bound(), command.workspace));
			return "current";
		}
		if (command.kind === "sync" && !level) return "stale";
		if (
			previous &&
			previous.file !== command.file &&
			(fs.existsSync(previous.file) || previous.file_binding !== bindingKey(command.stamp.binding))
		)
			throw new Error("Another transcript already uses this session ID");
		// Inside the write lock: a file deleted or replaced since the command was queued must not get its rows back.
		if (fileBinding(command.file) !== bindingKey(command.stamp.binding)) return "skipped";
		// The file only grows: rows another process saved from more of this same file are newer than this snapshot.
		if (
			command.kind === "save" &&
			previous?.file === command.file &&
			previous.file_binding === bindingKey(command.stamp.binding) &&
			previous.byte_size > command.stamp.size
		)
			return "current";
		agent.transaction(() => {
			const owner = bound();
			const workspaceId = claimWorkspace(agent, owner, command.workspace);
			if (!owner || previous?.file !== command.file) sessions.bind(agent.db, command.sessionId, workspaceId);
		});
		if (command.kind === "save") {
			rest = startSave(mirror, command, previous, plan, steps);
			return "saved";
		}
		if (command.entries?.length) {
			transcripts.writeStamp(
				mirror.db,
				command.sessionId,
				command.file,
				command.header ?? "{}",
				command.stamp,
				previous?.file,
			);
			transcripts.insertEntries(mirror.db, command.sessionId, command.entries);
		}
		return "saved";
	});
	return rest ? rest() : result;
}

/** Read and parse on the writer thread. Atomic replacement or an append during the read invalidates the snapshot. */
function readSnapshot(
	command: Extract<TranscriptCommand, { kind: "save-file" }>,
): Extract<TranscriptCommand, { kind: "save" }> | undefined {
	const stamp = getFileStamp(command.file);
	if (stamp.binding !== command.binding) return undefined;
	const fd = fs.openSync(
		command.file,
		fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
	);
	let bytes: Buffer;
	try {
		const opened = fs.fstatSync(fd, { bigint: true });
		if (!opened.isFile()) throw new Error("Session file is not a regular file");
		if (`${opened.ino}:${opened.birthtimeNs}` !== stamp.binding) return undefined;
		bytes = fs.readFileSync(fd);
		const after = getFileStamp(command.file);
		if (after.binding !== stamp.binding) return undefined;
		if (bytes.length !== stamp.size || after.size !== stamp.size || after.mtime !== stamp.mtime)
			throw new Error("Session file changed while it was read");
	} finally {
		fs.closeSync(fd);
	}
	let header: string | undefined;
	const records: MirrorRecord[] = [];
	for (let at = 0; at < bytes.length;) {
		const newline = bytes.indexOf(10, at);
		const end = newline < 0 ? bytes.length : newline;
		const json = bytes.toString("utf8", at, end);
		at = end + 1;
		const parsed = parseJsonlLine(json);
		if (!parsed?.ok || !parsed.value) continue;
		const record = parsed.value as { id?: unknown; parentId?: unknown; type?: unknown };
		if (header === undefined) {
			if (record.type !== "session" || record.id !== command.sessionId)
				throw new Error("Session file identity changed");
			header = json;
		} else
			records.push({
				id: String(record.id),
				parentId: typeof record.parentId === "string" ? record.parentId : null,
				type: String(record.type),
				json,
			});
	}
	if (header === undefined) throw new Error("Session file identity changed");
	return { ...command, kind: "save", stamp, header, records };
}

/** Register the transcript's workspace; a transcript bound to another, or to one that is gone, is refused. */
function claimWorkspace(
	agent: AgentDb,
	bound: string | null | undefined,
	workspace: MirrorWorkspace | null,
): string | null {
	if (bound && bound !== workspace?.id) throw new Error("Transcript belongs to a different or unavailable workspace");
	if (!workspace) return null;
	workspaces.register(agent.db, workspace);
	return workspace.id;
}

/** Record an explicitly created fork; its parent must already be mirrored (this queue saved it first). */
function linkFork(agent: AgentDb, command: Extract<TranscriptCommand, { kind: "fork" }>): TranscriptResult {
	const source = command.parent;
	const mirror = agent.mirror.db;
	// A stored ID came from SQLite. Its historical path is descriptive and is never resolved or opened.
	const parent = "storedId" in source ? source.storedId : transcripts.fileOwner(mirror, source.file);
	// The parent is a session of this database (its coordination row), as the edge's foreign key requires.
	if (!parent || ("expectedId" in source && source.expectedId !== parent) || !sessions.byId(agent.db, parent))
		return "skipped";
	workspaces.register(agent.db, command.workspace);
	sessions.bind(agent.db, command.child, command.workspace.id);
	forks.link(agent.db, mirror, command.child, command.childFile, parent);
	return "saved";
}

/** `ino:birth` of `file`, or undefined when it is gone. */
function fileBinding(file: string): string | undefined {
	const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
	return stat ? `${stat.ino}:${stat.birthtimeNs}` : undefined;
}
