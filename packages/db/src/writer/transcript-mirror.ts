import fs from "node:fs";
import { bindingKey } from "../binding.ts";
import type { AgentDb } from "../db.ts";
import * as transcripts from "../queries/transcripts.ts";
import * as workspaces from "../queries/workspaces.ts";
import { planSave, type SaveSteps, startSave } from "./transcript-save.ts";

/**
 * The session-mirror commands the database writer runs (`client.ts`, `worker.ts`). The session file is the record; these
 * rows are a derived copy. Every command is plain data: its stamps were taken by the session writer under its file lock,
 * right after the bytes they describe, and are never re-read here, so a stored stamp cannot get ahead of the stored entries.
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
 * Run one command as one transaction of `agent`; a `save` writes only what differs from the stored rows, and with
 * `steps` a large difference goes in several bounded transactions (`transcript-save.ts`). Throws what the caller reports
 * as a pending mirror.
 */
export function runTranscriptCommand(agent: AgentDb, command: TranscriptCommand, steps?: SaveSteps): TranscriptResult {
	if (command.kind === "fork") return agent.transaction(() => linkFork(agent, command));
	// Read before the write lock: comparing a large transcript must not hold other writers.
	const plan = command.kind === "save" ? planSave(agent, command) : undefined;
	let rest: (() => TranscriptResult) | undefined;
	const result = agent.transaction((): TranscriptResult => {
		const previous = transcripts.stamp(agent.db, command.sessionId);
		const level =
			previous?.file === command.file &&
			previous.file_binding === bindingKey(command.stamp.binding) &&
			(command.kind === "sync" && command.entries
				? previous.byte_size === command.previous?.size && previous.mtime === command.previous.mtime
				: previous.byte_size === command.stamp.size && previous.mtime === command.stamp.mtime);
		if (command.kind === "sync" && !command.entries) {
			if (!level) return "stale";
			claimWorkspace(agent, previous.workspace_id, command.workspace);
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
		const workspaceId = claimWorkspace(agent, previous?.workspace_id, command.workspace);
		if (!previous?.workspace_id || previous.file !== command.file)
			transcripts.bind(agent.db, command.sessionId, workspaceId);
		if (command.kind === "save") {
			rest = startSave(agent, command, previous, plan, steps);
			return "saved";
		}
		if (command.entries?.length) {
			transcripts.writeStamp(
				agent.db,
				command.sessionId,
				command.file,
				command.header ?? "{}",
				command.stamp,
				previous?.file,
			);
			transcripts.insertEntries(agent.db, command.sessionId, command.entries);
		}
		return "saved";
	});
	return rest ? rest() : result;
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
	// A stored ID came from SQLite. Its historical path is descriptive and is never resolved or opened.
	const parent = "storedId" in source ? source.storedId : transcripts.fileOwner(agent.db, source.file)?.id;
	if (!parent || ("expectedId" in source && source.expectedId !== parent)) return "skipped";
	workspaces.register(agent.db, command.workspace);
	transcripts.bind(agent.db, command.child, command.workspace.id);
	transcripts.linkFork(agent.db, command.child, command.childFile, parent);
	return "saved";
}

/** `ino:birth` of `file`, or undefined when it is gone. */
function fileBinding(file: string): string | undefined {
	const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
	return stat ? `${stat.ino}:${stat.birthtimeNs}` : undefined;
}
