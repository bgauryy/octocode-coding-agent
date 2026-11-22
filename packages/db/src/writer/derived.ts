import type { AgentDb } from "../db.ts";
import * as memories from "../queries/memories.ts";
import * as sessions from "../queries/sessions.ts";
import { withBusyTimeout } from "../sqlite.ts";
import { runTranscriptCommand, type TranscriptCommand, type TranscriptResult } from "./transcript-mirror.ts";
import type { SaveSteps } from "./transcript-save.ts";
import { archiveHistory, type HousekeepingResult } from "../retention.ts";
import { archivedAudits, type HistoryWindows, type ArchiveAuditQuery, type ArchiveRow } from "../history-archive.ts";

/**
 * Bookkeeping writes the interactive thread makes on every prompt or turn and never reads back at once: when a memory
 * was last handed to the model, a session's usage, catalog row, git state, name and end. Each is one statement in one
 * transaction of the writer (`client.ts`), in submission order, so a later `session-end` cannot land before the stats
 * of the turn that preceded it. Plain data only: every value was taken by the caller when it asked.
 */
export type DerivedCommand =
	| { kind: "memory-used"; context: memories.MemoryContext; ids: number[]; now: number }
	| { kind: "session-stats"; id: string; stats: sessions.StatsRow }
	| { kind: "session-catalog"; id: string; entry: sessions.CatalogEntry }
	| { kind: "session-git"; id: string; branch: string | null; head: string | null }
	| {
			kind: "session-title";
			id: string;
			title: string | null;
			source: string | null;
			fileMtime: number | null;
			owner: { cwd: string; file: string };
	  }
	| { kind: "session-end"; id: string; pid: number };

/** Every command a database writer runs: the session mirror's and the bookkeeping ones. */
export type DbWriterCommand =
	| TranscriptCommand
	| DerivedCommand
	| { kind: "archive-audits"; query: ArchiveAuditQuery }
	| { kind: "archive-history"; now: number; windows: HistoryWindows };
/** `done` for a bookkeeping command; a mirror command's own result otherwise. */
export type DbWriterResult = TranscriptResult | "done" | HousekeepingResult | ArchiveRow[];

const DERIVED = new Set<DerivedCommand["kind"]>([
	"memory-used",
	"session-stats",
	"session-catalog",
	"session-git",
	"session-title",
	"session-end",
]);

const isDerived = (command: DbWriterCommand): command is DerivedCommand =>
	DERIVED.has(command.kind as DerivedCommand["kind"]);

/** Runs one command of either family as the writer does: one transaction, or bounded steps for a large mirror save. */
function runWriterCommand(
	agent: AgentDb,
	command: DbWriterCommand,
	steps?: SaveSteps,
	assertActive?: () => void,
): DbWriterResult {
	if (command.kind === "archive-history") return archiveHistory(agent, command.now, command.windows, assertActive);
	if (command.kind === "archive-audits") {
		const { now, repo, ref, before, limit, windows } = command.query;
		return archivedAudits(agent, now, repo, ref, before, Math.min(500, Math.max(1, Math.floor(limit))), windows);
	}
	if (!isDerived(command)) return runTranscriptCommand(agent, command, steps);
	agent.transaction(() => runDerived(agent, command));
	return "done";
}

/**
 * `runWriterCommand` with every connection the command uses waiting at most `ms` for another process's lock: the
 * coordination file's, and the transcript mirror's for a mirror command (a bookkeeping one never opens the mirror).
 */
export function runWriterCommandWithin(
	agent: AgentDb,
	command: DbWriterCommand,
	ms: number,
	steps?: SaveSteps,
	assertActive?: () => void,
): DbWriterResult {
	const run = () => runWriterCommand(agent, command, steps, assertActive);
	if (command.kind === "archive-history" || command.kind === "archive-audits" || isDerived(command))
		return withBusyTimeout(agent.db, ms, run);
	return withBusyTimeout(agent.db, ms, () => withBusyTimeout(agent.mirror.db, ms, run));
}

function runDerived(agent: AgentDb, command: DerivedCommand): void {
	const { db } = agent;
	switch (command.kind) {
		case "memory-used":
			return memories.markUsed(db, command.context, command.ids, command.now);
		case "session-stats":
			return sessions.saveStats(db, command.id, command.stats);
		case "session-catalog":
			return sessions.saveCatalog(db, command.id, command.entry);
		case "session-git":
			return sessions.saveGit(db, command.id, command.branch, command.head);
		case "session-title":
			return sessions.saveTitle(db, command.id, command.title, command.source, command.fileMtime, command.owner);
		case "session-end":
			return sessions.clearPid(db, command.id, command.pid);
	}
}
