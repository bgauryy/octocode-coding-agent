import { type CompactionThinking, builtInCompactionSettings } from "../../core/compaction/settings.ts";
import type { ExtensionAPI } from "../../core/extensions/index.ts";

/** The session's thinking level and custom budgets, which size the compaction reserve. */
export function compactionThinking(pi: Pick<ExtensionAPI, "getThinkingLevel" | "getSettings">): CompactionThinking {
	return { level: pi.getThinkingLevel(), budgets: pi.getSettings().thinkingBudgets };
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
