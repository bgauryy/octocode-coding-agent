import { storedText } from "@octocodeai/octocode-common/sanitize";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { USER_AUTHOR } from "../../../../../db/src/api.ts";
import { promptSource } from "../../../core/prompt-template.ts";
import { SYSTEM_PROMPT_SECTIONS } from "../../../core/system-prompt-spec.ts";
import { MemoryError } from "../errors.ts";
import { memoryLabel, normalizeTitle } from "../query.ts";
import type { Memory, MemoryKind } from "../record.ts";
import type { MemoryStore } from "../store.ts";
import { isCandidate } from "./candidate-tags.ts";
import { contextRepeats, type MemoryOp } from "./consolidate.ts";
import {
	countedLines,
	lineCap,
	lineProblem,
	memoryDate,
	type MemoryLine,
	memoryLineKey,
	type MemorySection,
	type MemorySource,
	parseMemoryFile,
} from "./format.ts";
import { globalMemoryFile, type MemoryFileRef, workspaceMemoryFile } from "../../permission/memory-files.ts";
import { type MemorySettings, writesExplicit } from "./settings.ts";
import {
	MemoryFileError,
	type MemoryFileUpdate,
	MemoryFileTrackedError,
	readMemoryFile,
	updateMemoryFile,
} from "./writer.ts";

/**
 * Keeps the MEMORY.md files in step with the notes database: a save of a workspace or global note writes its title as
 * the file's line (the body stays in the database), a delete removes the line, and lines evicted to fit the cap are
 * kept in the database, so nothing is lost. The database stays the archive and search index.
 */

/** What the write path needs to reach the files: the settings, and what a new line must not repeat. */
export interface MemoryFileSync {
	settings: () => MemorySettings;
	/** AGENTS.md files and shipped policy the session loaded (`contextRepeats`). */
	repeats: () => ((text: string) => string | undefined) | undefined;
	env?: NodeJS.ProcessEnv;
}

const SECTION_OF_KIND: Record<MemoryKind, MemorySection> = {
	preference: "Preferences",
	decision: "Decisions",
	gotcha: "Gotchas",
	procedure: "Procedures",
	reference: "Pointers",
	fact: "Pointers",
};
const KIND_OF_SECTION: Record<MemorySection, MemoryKind> = {
	Preferences: "preference",
	Decisions: "decision",
	Gotchas: "gotcha",
	Procedures: "procedure",
	Pointers: "reference",
	Reflections: "fact",
};

/** The author a line's source is archived as, and back. */
const authorOfSource = (source: MemorySource): string => (source === "user" ? USER_AUTHOR : source);
const sourceOfAuthor = (author: string): MemorySource =>
	author === USER_AUTHOR ? "user" : author === "reflection" ? "reflection" : "agent";

/** The file a note of `scope` belongs to: global and workspace notes have one, project and session notes none. */
function fileOfScope(
	scope: Memory["scope"],
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): MemoryFileRef | undefined {
	if (scope === "global") return globalMemoryFile(env);
	return scope === "workspace" ? workspaceMemoryFile(cwd) : undefined;
}

/** The line a note becomes: its title, in the section of its kind, dated `now`. */
function lineOfMemory(
	memory: Pick<Memory, "title" | "kind" | "pinned" | "author">,
	now: Date | number = Date.now(),
): MemoryLine {
	return {
		section: SECTION_OF_KIND[memory.kind],
		pinned: memory.pinned,
		text: storedText(memory.title).replace(/\s+/g, " "),
		source: sourceOfAuthor(memory.author),
		date: memoryDate(now),
	};
}

/**
 * Refusals that come before the database write when the note will be a file line: a title too long for a line, or a
 * new title (`previousTitle` differs) that repeats AGENTS.md or shipped policy, which every session already reads.
 */
export function precheckFileLine(
	sync: MemoryFileSync | undefined,
	memory: Pick<Memory, "title" | "kind" | "pinned" | "author" | "scope">,
	previousTitle?: string,
): void {
	if (!sync || memory.scope === "project" || !writesExplicit(sync.settings())) return;
	const line = lineOfMemory(memory);
	const problem = lineProblem(line);
	if (problem)
		throw new MemoryError(
			`The title becomes the MEMORY.md line, which it cannot be (${problem}): keep the title to the rule and why; put detail in body.`,
		);
	if (previousTitle !== undefined && normalizeTitle(previousTitle) === normalizeTitle(memory.title)) return;
	const repeat = sync.repeats()?.(line.text);
	if (repeat) throw new MemoryError(`Not saved: every session already reads this (${repeat}).`);
}

/**
 * Lines `update` evicted, kept as database notes when none holds them yet: what to name in a result. A queued candidate
 * with the same text does not count, since a consolidation pass drops it.
 */
export async function archive(
	store: MemoryStore,
	file: MemoryFileRef,
	lines: readonly MemoryLine[],
): Promise<string[]> {
	const names: string[] = [];
	for (const line of lines) {
		const key = memoryLineKey(line.text);
		const held = store
			.search(line.text, "all", 10)
			.find((memory) => !isCandidate(memory) && normalizeTitle(memory.title) === key);
		if (held) {
			names.push(`"${line.text.slice(0, 60)}" (${memoryLabel(held.id)})`);
			continue;
		}
		try {
			const { memory } = store.set({
				title: line.text,
				kind: KIND_OF_SECTION[line.section],
				scope: file.scope === "global" ? "global" : "project",
				keywords: `memory-file ${line.section.toLowerCase()} ${line.date ?? ""}`.trim(),
				author: authorOfSource(line.source),
			});
			names.push(`"${line.text.slice(0, 60)}" (${memoryLabel(memory.id)})`);
		} catch (error) {
			// A similar note already holds it; the database refuses a second.
			if (!(error instanceof MemoryError)) throw error;
			names.push(`"${line.text.slice(0, 60)}" (similar to an archived note)`);
		}
	}
	return names;
}

/** Applies `ops` to `file` and says what changed, for the tool result; a refused change is reported, not thrown. */
async function apply(
	sync: MemoryFileSync,
	store: MemoryStore,
	file: MemoryFileRef,
	ops: MemoryOp[],
	options: { allowPinChanges: boolean; signal?: AbortSignal; label: string },
): Promise<string> {
	const name = file.scope === "global" ? "global MEMORY.md" : "workspace MEMORY.md";
	try {
		// Lines evicted to fit go to the database before the file loses them; a line the ops evict is the user's removal.
		let evicted: string[] = [];
		const beforeWrite = async (planned: MemoryFileUpdate) => {
			evicted = await archive(
				store,
				file,
				planned.evicted.filter(
					(line) => !ops.some((op) => op.op === "evict" && memoryLineKey(op.target) === memoryLineKey(line.text)),
				),
			);
		};
		const update = await updateMemoryFile(
			file,
			ops,
			{
				allowPinChanges: options.allowPinChanges,
				...(options.signal ? { signal: options.signal } : {}),
				beforeWrite,
			},
			sync.env,
		);
		// An unchanged file says nothing, unless an op was refused for a reason worth knowing (a repeat, a pin).
		if (!update.changed) return update.skipped[0] ? `${name} unchanged: ${update.skipped[0].reason}.` : "";
		const cap = lineCap(file.scope);
		return `${name}: ${countedLines(update.lines)}/${cap} lines${evicted.length ? `; moved to the archive to fit: ${evicted.join(", ")}` : ""}.`;
	} catch (error) {
		if (error instanceof MemoryFileTrackedError) return `${name} not written: ${error.message}`;
		if (error instanceof MemoryFileError) return `${name} not changed: ${error.message}`;
		throw new Error(
			`${options.label} is saved in the notes database, but ${file.path} could not be written: ${errorMessage(error)}`,
			{ cause: error },
		);
	}
}

/**
 * After a save: the note's line leaves the file it was in (a rename, a scope move, a pin change) and is written to the
 * file of its scope; an unchanged title confirms the line (its date moves on). `approved`: the user confirmed this
 * change (a global or pinned note), so pinned lines may change.
 */
export async function syncSavedMemory(
	sync: MemoryFileSync | undefined,
	change: {
		store: MemoryStore;
		cwd: string;
		before: Memory | undefined;
		saved: Memory;
		approved: boolean;
		signal?: AbortSignal;
	},
): Promise<string> {
	if (!sync || !writesExplicit(sync.settings())) return "";
	const { store, before, saved } = change;
	const env = sync.env ?? process.env;
	const from = before ? fileOfScope(before.scope, change.cwd, env) : undefined;
	const to = fileOfScope(saved.scope, change.cwd, env);
	const allowPinChanges = change.approved || Boolean(before?.pinned);
	const line = lineOfMemory(saved);
	const label = memoryLabel(saved.id);
	const notes: string[] = [];
	const leave: MemoryOp[] = before ? [{ op: "evict", target: before.title }] : [];
	if (from && from.path !== to?.path)
		notes.push(
			await apply(sync, store, from, leave, {
				allowPinChanges,
				label,
				...(change.signal ? { signal: change.signal } : {}),
			}),
		);
	if (to) {
		// An unchanged line is confirmed in place; a changed one replaces the old line.
		const same = before && from?.path === to.path && (await lineUnchanged(to, before, saved, env));
		const ops: MemoryOp[] = [
			...(before && from?.path === to.path && !same ? leave : []),
			{ op: "add", section: line.section, text: line.text, source: line.source, pinned: line.pinned },
		];
		notes.push(
			await apply(sync, store, to, ops, {
				allowPinChanges,
				label,
				...(change.signal ? { signal: change.signal } : {}),
			}),
		);
	}
	return notes.filter(Boolean).join("\n");
}

/** Whether `saved` writes the same line `before` already has in `file` (same text, section and pin). */
async function lineUnchanged(
	file: MemoryFileRef,
	before: Memory,
	saved: Memory,
	env: NodeJS.ProcessEnv,
): Promise<boolean> {
	if (normalizeTitle(before.title) !== normalizeTitle(saved.title)) return false;
	const text = await readMemoryFile(file, env);
	const current = parseMemoryFile(text ?? "").lines.find(
		(line) => memoryLineKey(line.text) === memoryLineKey(saved.title),
	);
	const next = lineOfMemory(saved);
	return current !== undefined && current.section === next.section && current.pinned === next.pinned;
}

/** After a delete: the note's line leaves its file. */
export async function syncDeletedMemory(
	sync: MemoryFileSync | undefined,
	change: { store: MemoryStore; cwd: string; removed: Memory; approved: boolean; signal?: AbortSignal },
): Promise<string> {
	if (!sync || !writesExplicit(sync.settings())) return "";
	const file = fileOfScope(change.removed.scope, change.cwd, sync.env);
	if (!file) return "";
	return apply(sync, change.store, file, [{ op: "evict", target: change.removed.title }], {
		allowPinChanges: change.approved,
		label: memoryLabel(change.removed.id),
		...(change.signal ? { signal: change.signal } : {}),
	});
}

/** Notes read when matching file lines to notes; far more than a person keeps. */
const MEMBER_SCAN = 500;

/** The notes whose title is a line the prompt already carries (`keys`, normalized), so recall skips them. */
export function fileMemberIds(store: Pick<MemoryStore, "list">, keys: ReadonlySet<string>): number[] {
	if (keys.size === 0) return [];
	return store
		.list("all", MEMBER_SCAN)
		.filter((memory) => keys.has(normalizeTitle(memory.title)))
		.map((memory) => memory.id);
}

/**
 * The repeat check over the AGENTS.md files a session loaded and the shipped policy chunks, built once per set of
 * files. Claude Code's MEMORY.md, loaded as a context file, is not policy and is left out.
 */
export function repeatsOf(
	contextFiles: ReadonlyArray<{ path: string; content: string }>,
): (text: string) => string | undefined {
	const policy = SYSTEM_PROMPT_SECTIONS.filter((spec) => spec.group === "policy").flatMap((spec) =>
		(spec.chunks ?? []).map((chunk) => ({ name: chunk.file, text: promptSource(chunk.file) })),
	);
	const files = contextFiles
		.filter((file) => !/(^|[\\/])MEMORY\.md$/i.test(file.path))
		.map((file) => ({ name: file.path, text: file.content }));
	return contextRepeats([...files, ...policy]);
}
