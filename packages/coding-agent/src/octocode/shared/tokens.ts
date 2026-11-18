import { type CompactionThinking, builtInCompactionSettings } from "../../core/compaction/settings.ts";
import type { SetupPick } from "../../core/features/index.ts";

/** The session's thinking level and custom budgets, which size the compaction reserve. */
export function compactionThinking(
	api: SetupPick<"models", "getThinkingLevel"> & SetupPick<"settings", "get">,
): CompactionThinking {
	return { level: api.models.getThinkingLevel(), budgets: api.settings.get().thinkingBudgets };
}

export function reserveTokensFor(
	model: { provider: string; id: string; contextWindow?: number },
	thinking?: CompactionThinking,
): number {
	return builtInCompactionSettings(model, thinking).reserveTokens;
}

export function autoCompactAt(
	model: { provider: string; id: string; contextWindow: number },
	thinking?: CompactionThinking,
): number {
	return Math.max(0, model.contextWindow - builtInCompactionSettings(model, thinking).reserveTokens);
}
