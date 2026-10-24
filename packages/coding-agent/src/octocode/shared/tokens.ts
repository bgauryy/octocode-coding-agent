import { builtInCompactionSettings } from "../../core/compaction/settings.ts";

export function reserveTokensFor(model: { provider: string; id: string; contextWindow?: number }): number {
	return builtInCompactionSettings(model).reserveTokens;
}

export function autoCompactAt(model: { provider: string; id: string; contextWindow: number }): number {
	return Math.max(0, model.contextWindow - builtInCompactionSettings(model).reserveTokens);
}
