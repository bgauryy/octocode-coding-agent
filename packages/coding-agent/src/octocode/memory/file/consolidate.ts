import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { MemoryFileScope } from "../../permission/memory-files.ts";
import { jaccard, stem, terms } from "../query.ts";
import {
	countedLines,
	lineCap,
	lineProblem,
	MEMORY_FILE_MAX_BYTES,
	MEMORY_LINE_MAX_CHARS,
	type MemoryLine,
	memoryLineKey,
	type MemorySection,
	type MemorySource,
	serializeMemoryFile,
} from "./format.ts";

/**
 * The only way a MEMORY.md changes: a list of ops a caller (a save, a reflection or consolidation model)
 * proposes and code applies. Ops are idempotent, so a writer that lost a race re-applies the same list to the new file:
 * an add finds its own line, a rewrite or merge whose result is already there does nothing, an evict of a missing line
 * does nothing, a flag marks its line `recheck` once. Targets name a line by its text (case, punctuation and spacing
 * ignored).
 */

/** The format's `MEMORY_SECTIONS` and `MEMORY_SOURCES`, spelled out so the op types are exact (tested to agree). */
const SectionSchema = Type.Union([
	Type.Literal("Preferences"),
	Type.Literal("Decisions"),
	Type.Literal("Gotchas"),
	Type.Literal("Procedures"),
	Type.Literal("Pointers"),
	Type.Literal("Reflections"),
]);
const SourceSchema = Type.Union([Type.Literal("user"), Type.Literal("reflection"), Type.Literal("agent")]);

const TextSchema = Type.String({ minLength: 1, maxLength: MEMORY_LINE_MAX_CHARS });
const TargetSchema = Type.String({ minLength: 1, maxLength: 400 });

const MemoryOpSchema = Type.Union([
	Type.Object(
		{
			op: Type.Literal("add"),
			section: SectionSchema,
			text: TextSchema,
			source: Type.Optional(SourceSchema),
			pinned: Type.Optional(Type.Boolean()),
			/** When the fact was last confirmed, if not now. */
			date: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			op: Type.Literal("merge"),
			targets: Type.Array(TargetSchema, { minItems: 2, maxItems: 10 }),
			text: TextSchema,
			section: Type.Optional(SectionSchema),
			source: Type.Optional(SourceSchema),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			op: Type.Literal("rewrite"),
			target: TargetSchema,
			text: TextSchema,
			section: Type.Optional(SectionSchema),
			source: Type.Optional(SourceSchema),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ op: Type.Literal("evict"), target: TargetSchema, reason: Type.Optional(Type.String({ maxLength: 200 })) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ op: Type.Literal("flag"), target: TargetSchema, reason: Type.String({ minLength: 1, maxLength: 200 }) },
		{ additionalProperties: false },
	),
]);
const MemoryOpsSchema = Type.Array(MemoryOpSchema, { maxItems: 40 });
export type MemoryOp = Static<typeof MemoryOpSchema>;

/** `value` as an op list (a model's JSON, say), or an error naming the first problems; nothing is applied. */
export function parseMemoryOps(value: unknown): MemoryOp[] {
	if (Value.Check(MemoryOpsSchema, value)) return value;
	const errors = [...Value.Errors(MemoryOpsSchema, value)]
		.slice(0, 3)
		.map((error) => `${error.instancePath || "/"} ${error.message}`);
	throw new Error(`Invalid memory ops: ${errors.join("; ")}`);
}

export interface AppliedOps {
	lines: MemoryLine[];
	/** Lines an `evict` op removed (eviction to fit is `evictToFit`'s). */
	evicted: MemoryLine[];
	/** Lines a `flag` op named, with why; each is marked `recheck` in the file unless it is pinned. */
	flagged: Array<{ line: MemoryLine; reason: string }>;
	/** Ops that changed nothing, and why: a missing target, a pinned line, a repeat of AGENTS.md or policy. */
	skipped: Array<{ op: MemoryOp; reason: string }>;
}

interface ApplyOptions {
	/** The confirmation date ops stamp: `YYYY-MM-DD`. */
	date: string;
	/** The user approved changing pinned lines (and adding pinned ones). */
	allowPinChanges?: boolean;
	/** What an added or rewritten text repeats (`contextRepeats`), or undefined. */
	repeats?: (text: string) => string | undefined;
}

const SOURCE_RANK: Record<MemorySource, number> = { user: 3, reflection: 2, agent: 1 };
const SECTION_RANK: Record<MemorySection, number> = {
	Preferences: 3,
	Decisions: 3,
	Gotchas: 2,
	Procedures: 2,
	Pointers: 1,
	Reflections: 1,
};
const higher = (a: MemorySource, b: MemorySource): MemorySource => (SOURCE_RANK[a] >= SOURCE_RANK[b] ? a : b);
const later = (a: string | undefined, b: string | undefined): string | undefined => (!a ? b : !b || a >= b ? a : b);

/** Applies `ops` in order to a copy of `lines`. */
export function applyMemoryOps(
	lines: readonly MemoryLine[],
	ops: readonly MemoryOp[],
	options: ApplyOptions,
): AppliedOps {
	let current = lines.map((line) => ({ ...line }));
	const result: Omit<AppliedOps, "lines"> = { evicted: [], flagged: [], skipped: [] };
	const find = (target: string) => {
		const key = memoryLineKey(target.replace(/^\s*[-*]\s+!?\s*/, "").replace(/\s*\([^()]*\)\s*$/, ""));
		const exact = memoryLineKey(target);
		return current.findIndex((line) => {
			const own = memoryLineKey(line.text);
			return own === key || own === exact;
		});
	};
	const skip = (op: MemoryOp, reason: string) => result.skipped.push({ op, reason });
	const locked = (line: MemoryLine) => line.pinned && !options.allowPinChanges;
	for (const op of ops) {
		if (op.op === "flag" || op.op === "evict") {
			const at = find(op.target);
			if (at === -1) skip(op, "no line matches the target");
			else if (op.op === "flag") {
				result.flagged.push({ line: current[at], reason: op.reason });
				current[at] = markRecheck(current[at], locked(current[at]));
			} else if (locked(current[at])) skip(op, "the line is pinned");
			else result.evicted.push(...current.splice(at, 1));
			continue;
		}
		const text = op.text.replace(/\s+/g, " ").trim();
		const existing = find(text);
		if (op.op === "add") {
			if (existing !== -1) {
				// Saving what the file already says confirms it: the date moves on and the higher source stays.
				const line = current[existing];
				if (locked(line)) skip(op, "already pinned");
				else
					current[existing] = {
						...line,
						date: later(line.date, op.date ?? options.date),
						source: higher(line.source, op.source ?? "agent"),
					};
				continue;
			}
			const repeat = options.repeats?.(text);
			if (repeat) {
				skip(op, `repeats ${repeat}`);
				continue;
			}
			if (op.pinned && !options.allowPinChanges) skip(op, "pinning needs the user's approval; added unpinned");
			current.push({
				section: op.section,
				pinned: Boolean(op.pinned && options.allowPinChanges),
				text,
				source: op.source ?? "agent",
				date: op.date ?? options.date,
			});
			continue;
		}
		const targets = (op.op === "rewrite" ? [op.target] : op.targets).map(find).filter((at) => at !== -1);
		if (targets.length === 0) {
			skip(op, existing === -1 ? "no line matches the target" : "already applied");
			continue;
		}
		const picked = [...new Set(targets)].map((at) => current[at]);
		if (picked.some(locked) || (existing !== -1 && locked(current[existing]))) {
			skip(op, "a target line is pinned");
			continue;
		}
		const repeat = existing === -1 ? options.repeats?.(text) : undefined;
		if (repeat) {
			skip(op, `repeats ${repeat}`);
			continue;
		}
		const first = picked[0];
		const merged: MemoryLine = {
			section: op.section ?? first.section,
			pinned: picked.some((line) => line.pinned),
			text,
			// An edit makes its writer the source (an agent's edit of a user's line is the agent's); a merge keeps the
			// strongest source of what it combines, and its newest date, since combining confirms nothing new.
			source:
				op.op === "rewrite" ? (op.source ?? "agent") : (op.source ?? picked.map((line) => line.source).reduce(higher)),
			...(op.op === "rewrite"
				? { date: options.date }
				: { date: picked.map((line) => line.date).reduce(later) ?? options.date }),
		};
		// A rewrite onto another line's text merges into it.
		const replaced = new Set([...picked, ...(existing !== -1 ? [current[existing]] : [])]);
		const position = Math.min(...[...replaced].map((line) => current.indexOf(line)));
		current = current.flatMap((line, index) => (index === position ? [merged] : replaced.has(line) ? [] : [line]));
	}
	return { lines: current, ...result };
}

/** The trailer note a flagged line carries until a rewrite or merge settles it: `(agent 2026-11-19, recheck)`. */
const RECHECK = "recheck";

/**
 * `line` marked for a recheck, so the next agent and the user see the flag in the file. A pinned line keeps its bytes,
 * and a line the note would push past 200 characters is only reported.
 */
function markRecheck(line: MemoryLine, locked: boolean): MemoryLine {
	if (locked || line.note?.split(/,\s*/).includes(RECHECK)) return line;
	const marked = { ...line, note: line.note ? `${line.note}, ${RECHECK}` : RECHECK };
	return lineProblem(marked) ? line : marked;
}

/** Keep-first rank of an unpinned line: its source, then its section's kind, then its date (newest first). */
export function evictionRank(line: MemoryLine): [number, number, string] {
	return [SOURCE_RANK[line.source], SECTION_RANK[line.section], line.date ?? ""];
}

const compareRank = (a: MemoryLine, b: MemoryLine): number => {
	const [sa, ka, da] = evictionRank(a);
	const [sb, kb, db] = evictionRank(b);
	return sa - sb || ka - kb || (da < db ? -1 : da > db ? 1 : 0);
};

/**
 * Removes the lowest-ranked unpinned lines until the file fits `maxLines` (headings counted) and 4 KB. Pinned lines are
 * never removed; when they alone exceed the cap, the result still does and the validator refuses it.
 */
export function evictToFit(
	lines: readonly MemoryLine[],
	scope: MemoryFileScope,
	maxLines?: number,
): { lines: MemoryLine[]; evicted: MemoryLine[] } {
	const cap = lineCap(scope, maxLines);
	let kept = [...lines];
	const evicted: MemoryLine[] = [];
	const fits = () => countedLines(kept) <= cap && Buffer.byteLength(serializeMemoryFile(kept)) <= MEMORY_FILE_MAX_BYTES;
	while (!fits()) {
		const candidates = kept.filter((line) => !line.pinned);
		if (candidates.length === 0) break;
		// Of equally ranked lines the one further down goes first: a line's position is its author's last ordering.
		const weakest = candidates.reduce((low, line) => (compareRank(line, low) <= 0 ? line : low));
		evicted.push(weakest);
		kept = kept.filter((line) => line !== weakest);
	}
	return { lines: kept, evicted };
}

/** Word overlap at which a line counts as repeating a sentence of AGENTS.md or shipped policy. */
const REPEAT_JACCARD = 0.5;
/** Shorter texts share words with too much by chance to be called a repeat. */
const MIN_REPEAT_TERMS = 4;

/**
 * A check of new text against `sources` (AGENTS.md files, shipped policy): the first sentence or list item sharing at
 * least half its words with the text (stemmed), named as `<source>: "<sentence>"`.
 */
export function contextRepeats(
	sources: ReadonlyArray<{ name: string; text: string }>,
): (text: string) => string | undefined {
	const stems = (text: string) => [...new Set(terms(text).map(stem))];
	const sentences = sources.flatMap(({ name, text }) =>
		text
			.replace(/\{\{[^}]*\}\}|<!--[\s\S]*?-->/g, " ")
			.split(/\n+|(?<=[.!?])\s+/)
			.map((sentence) => sentence.replace(/^[\s#>*|-]+/, "").trim())
			.filter((sentence) => stems(sentence).length >= MIN_REPEAT_TERMS)
			.map((sentence) => ({ name, sentence, words: stems(sentence) })),
	);
	return (text) => {
		const words = stems(text);
		if (words.length < MIN_REPEAT_TERMS) return undefined;
		const hit = sentences.find((entry) => jaccard(words, entry.words) >= REPEAT_JACCARD);
		return hit ? `${hit.name}: "${hit.sentence.slice(0, 100)}"` : undefined;
	};
}
