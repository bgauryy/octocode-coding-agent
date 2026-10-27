import type { ModelThinkingLevel, ThinkingBudgets } from "@octocodeai/octocode-ai";
import { thinkingBudgetForLevel } from "@octocodeai/octocode-ai/api/simple-options";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** Tokens kept for the visible answer next to the thinking budget. */
const ANSWER_ROOM_TOKENS = 8192;
/** Tokens the request's output clamp (`window - context - 4096`) takes before the reply gets any. */
const CONTEXT_CLAMP_TOKENS = 4096;

/** The part of a model the policy reads. */
export interface CompactionModel {
	contextWindow?: number;
	reasoning?: boolean;
	compat?: unknown;
}

/** The session's thinking setup: the level in force and any custom per-level token budgets. */
export interface CompactionThinking {
	level?: ModelThinkingLevel;
	budgets?: ThinkingBudgets;
}

/** Tokens of thinking one request can ask for; 0 when thinking is off, unknown or unsupported by the model. */
export function thinkingBudgetTokens(model: CompactionModel | undefined, thinking?: CompactionThinking): number {
	const level = thinking?.level;
	if (!level || level === "off" || model?.reasoning === false) return 0;
	// Adaptive-thinking models take an effort level, not a token budget: reserve for the largest one.
	const adaptive = (model?.compat as { forceAdaptiveThinking?: unknown } | undefined)?.forceAdaptiveThinking === true;
	const budget = thinkingBudgetForLevel(adaptive ? "high" : level, thinking?.budgets);
	return Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0;
}

/**
 * Compaction thresholds for `model`. The reserve is a fixed fraction of the window (at most the default). When the
 * caller names the session's thinking setup it is raised so a request near the threshold keeps its thinking budget
 * plus answer room, up to a sixth of the window, and never lowered. Without `thinking` the fraction stands.
 */
export function builtInCompactionSettings(model?: CompactionModel, thinking?: CompactionThinking) {
	const defaults = SETTINGS_DEFAULTS.compaction;
	const window = model?.contextWindow;
	if (window === undefined || !Number.isFinite(window) || window <= 0) return { ...defaults };
	const base = Math.min(defaults.reserveTokens, Math.max(1, Math.floor(window / 8)));
	const need = thinkingBudgetTokens(model, thinking) + ANSWER_ROOM_TOKENS + CONTEXT_CLAMP_TOKENS;
	return {
		enabled: true,
		reserveTokens: thinking ? Math.max(base, Math.min(need, Math.floor(window / 6))) : base,
		keepRecentTokens: Math.min(defaults.keepRecentTokens, Math.max(1, Math.floor(window / 4))),
	};
}
