import { builtInCompactionSettings } from "../../core/compaction/settings.ts";

/** The one characters-per-token ratio, shared with core's `estimateTokens` (see `core/compaction/tokens.ts`). */
export { CHARS_PER_TOKEN } from "../../core/compaction/tokens.ts";

export function reserveTokensFor(model: { provider: string; id: string; contextWindow?: number }): number {
	return builtInCompactionSettings(model).reserveTokens;
}

export function autoCompactAt(model: { provider: string; id: string; contextWindow: number }): number {
	return Math.max(0, model.contextWindow - builtInCompactionSettings(model).reserveTokens);
}
