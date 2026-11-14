import type { BashSyntax } from "./bash-types.ts";

/**
 * The parse of one command line, kept for the next checks of the same line. One tool call is read by several steps (the
 * permission reasons, write targets, git landings, source policy, provenance, reservations and the edit ledger), each
 * asking for the same parse; a parse depends only on the text, so the steps after the first share it. The parse is
 * frozen, so no step can change what the next one reads. Not kept: a line the parse gave up on (`bashSyntax`'s
 * unresolved answer, which may depend on the moment: the parser not loaded yet, a parse that ran out of time), and very
 * long lines.
 */
const KEPT = 64;
const KEPT_BYTES = 32 * 1024;
const UNRESOLVED = "Bash parse unavailable";
const kept = new Map<string, BashSyntax>();

export function rememberedSyntax(source: string, parse: (source: string) => BashSyntax): BashSyntax {
	const known = kept.get(source);
	if (known) {
		// Most recently used last, so the oldest is the one dropped.
		kept.delete(source);
		kept.set(source, known);
		return known;
	}
	const syntax = parse(source);
	if (source.length > KEPT_BYTES || syntax.targets.some((target) => target.uncertain === UNRESOLVED)) return syntax;
	kept.set(source, deepFreeze(syntax));
	if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
	return syntax;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}
