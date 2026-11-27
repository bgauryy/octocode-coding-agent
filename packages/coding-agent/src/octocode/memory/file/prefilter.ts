import { normalizeTitle } from "../query.ts";
import type { Memory } from "../record.ts";
import type { PassFile } from "./passes.ts";

/** The normalized keys of the lines `files` already hold: what a candidate that restates one adds nothing to. */
export const savedKeys = (files: readonly PassFile[]): Set<string> =>
	new Set(files.flatMap((file) => file.lines.map((line) => normalizeTitle(line.text))));

/**
 * Splits `candidates` before a model sees them. `resolved` are the ones code settles: text a saved line already says
 * (case, spacing and punctuation aside), a repeat of what `repeats` names, or a copy of an earlier candidate. `remaining`
 * are the ones that need judgment.
 */
export function splitCandidates(
	candidates: readonly Memory[],
	saved: ReadonlySet<string>,
	repeats?: (text: string) => string | undefined,
): { remaining: Memory[]; resolved: Memory[] } {
	const seen = new Set<string>();
	const remaining: Memory[] = [];
	const resolved: Memory[] = [];
	for (const memory of candidates) {
		const key = normalizeTitle(memory.title);
		const settled = key === "" || saved.has(key) || seen.has(key) || repeats?.(memory.title) !== undefined;
		seen.add(key);
		(settled ? resolved : remaining).push(memory);
	}
	return { remaining, resolved };
}
