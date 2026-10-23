import { builtInCompactionSettings } from "../../core/compaction/settings.ts";

/**
 * Characters per token for every estimate that has no tokenizer: what compaction adds back, and the system prompt and
 * tool definitions a request carries. Prose runs near four, but code, paths and JSON (most of a restored file, a pasted
 * log or a tool schema) tokenize nearer three, so three keeps the add-ons inside their share of the window and the
 * estimate on the safe side.
 */
export const CHARS_PER_TOKEN = 3;

export function reserveTokensFor(model: { provider: string; id: string; contextWindow?: number }): number {
	return builtInCompactionSettings(model).reserveTokens;
}

export function autoCompactAt(model: { provider: string; id: string; contextWindow: number }): number {
	return Math.max(0, model.contextWindow - builtInCompactionSettings(model).reserveTokens);
}
