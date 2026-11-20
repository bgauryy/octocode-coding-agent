import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import type { Memory } from "../record.ts";
import type { MemoryStore } from "../store.ts";
import { isCandidate } from "./candidate-tags.ts";
import type { MemoryOp } from "./consolidate.ts";
import { countedLines, lineCap, lineProblem } from "./format.ts";
import { globalMemoryFile, type MemoryFileRef, workspaceMemoryFile } from "../../permission/memory-files.ts";
import { lineOfMemory } from "./sync.ts";
import { type MemoryFileUpdate, updateMemoryFile } from "./writer.ts";

/**
 * `/memory migrate [--dry-run]`: one deterministic pass from the notes database to the MEMORY.md files. Workspace and
 * project notes go to the repository's file; global notes go to the global file only because they are already global
 * (a note is never moved to global here: that needs the user's approval per note). Each note's title is its line, dated
 * by its last update; lines that do not fit the cap stay in the database only. Notes stay in the database either way,
 * and a dry run writes nothing.
 */

/** Notes read per pass; far more than a person keeps. */
const MIGRATE_LIMIT = 1000;

interface MigrationResult {
	file: MemoryFileRef;
	update: MemoryFileUpdate;
	/** Notes that cannot be a line as they are (too long, a secret), with the reason. */
	unfit: Array<{ memory: Memory; reason: string }>;
}

export async function migrateMemories(
	store: MemoryStore,
	cwd: string,
	options: {
		dryRun: boolean;
		repeats?: (text: string) => string | undefined;
		env?: NodeJS.ProcessEnv;
		now?: Date | number;
	},
): Promise<MigrationResult[]> {
	const env = options.env ?? process.env;
	// Queued lesson candidates are checkpoint detail for a pass to judge, never file lines by themselves.
	const notes = store.list("all", MIGRATE_LIMIT).filter((memory) => !isCandidate(memory));
	const targets: Array<{ file: MemoryFileRef; notes: Memory[] }> = [
		{ file: globalMemoryFile(env), notes: notes.filter((memory) => memory.scope === "global") },
		{ file: workspaceMemoryFile(cwd), notes: notes.filter((memory) => memory.scope !== "global") },
	];
	const results: MigrationResult[] = [];
	for (const { file, notes: rows } of targets) {
		if (rows.length === 0) continue;
		const unfit: MigrationResult["unfit"] = [];
		const ops: MemoryOp[] = [];
		// Oldest first, so on equal rank the newest notes are the ones that stay.
		for (const memory of [...rows].sort((a, b) => a.updatedAt - b.updatedAt || a.id - b.id)) {
			const line = lineOfMemory(memory, memory.updatedAt);
			const problem = lineProblem(line);
			if (problem) {
				unfit.push({ memory, reason: problem });
				continue;
			}
			ops.push({
				op: "add",
				section: line.section,
				text: line.text,
				source: line.source,
				pinned: line.pinned,
				...(line.date ? { date: line.date } : {}),
			});
		}
		const update = await updateMemoryFile(
			file,
			ops,
			{
				dryRun: options.dryRun,
				// The user runs the migration: pinned notes become pinned lines.
				allowPinChanges: true,
				...(options.repeats ? { repeats: options.repeats } : {}),
				...(options.now !== undefined ? { now: options.now } : {}),
			},
			env,
		);
		results.push({ file, update, unfit });
	}
	return results;
}

/** The migration's report: per file its line count, the diff, and the notes left in the database only, with why. */
export function migrationReport(results: readonly MigrationResult[], dryRun: boolean): string {
	if (results.length === 0) return "No notes to migrate.";
	const out: string[] = [];
	for (const { file, update, unfit } of results) {
		const name = `${file.scope} ${homeTilde(file.path)}`;
		out.push(
			update.changed
				? `${dryRun ? "Would write" : "Wrote"} ${name}: ${countedLines(update.lines)}/${lineCap()} lines.`
				: `${name}: already up to date.`,
		);
		if (update.diff) out.push(update.diff.trimEnd());
		const left = [
			...update.evicted.map((line) => `  "${line.text.slice(0, 80)}": does not fit the cap`),
			...update.skipped.map(
				({ op, reason }) => `  "${"text" in op ? op.text.slice(0, 80) : op.target.slice(0, 80)}": ${reason}`,
			),
			...unfit.map(({ memory, reason }) => `  M${memory.id}: ${reason}`),
		];
		if (left.length > 0) out.push("Kept in the notes database only:", ...left);
	}
	out.push(
		dryRun
			? "Dry run: nothing was written. Run /memory migrate to write it."
			: "Every note stays in the notes database.",
	);
	return out.join("\n");
}
