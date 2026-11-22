import type { ModelThinkingLevel, ThinkingBudgets } from "@octocodeai/octocode-ai";
import { thinkingBudgetForLevel } from "@octocodeai/octocode-ai/api/simple-options";
import { DEFAULT_RESERVE_TOKENS, SETTINGS_DEFAULTS } from "../settings-defaults.ts";

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
 * The reserve that keeps the summary request inside the session's cached request just past the threshold: the room the
 * provider leaves for output there (`reserve - CONTEXT_CLAMP_TOKENS - 1`) holds an inline summary (`inlineSummaryTokens`:
 * 80% of the reserve). With less, that request fails its room check and the whole conversation is sent again outside
 * the cache. The target leaves slack for the context to pass the threshold by a few thousand tokens.
 */
const SUMMARY_ROOM_RESERVE_TOKENS = CONTEXT_CLAMP_TOKENS * 6;
/** The least reserve that still holds an inline summary just past the threshold; a window whose sixth is below it cannot. */
const SUMMARY_ROOM_MIN_RESERVE_TOKENS = CONTEXT_CLAMP_TOKENS * 5 + 5;

/**
 * Compaction thresholds for `model`. The reserve is a fixed fraction of the window (at most the default). When the
 * caller names the session's thinking setup it is raised so a request near the threshold keeps its thinking budget
 * plus answer room, up to a sixth of the window, and never lowered. Either way, a window large enough to allow it gets
 * at least {@link SUMMARY_ROOM_RESERVE_TOKENS} (within a sixth of the window), so the summary is written in-cache at
 * the threshold; a smaller one keeps its fraction.
 */
export function builtInCompactionSettings(model?: CompactionModel, thinking?: CompactionThinking) {
	const defaults = SETTINGS_DEFAULTS.compaction;
	const window = model?.contextWindow;
	if (window === undefined || !Number.isFinite(window) || window <= 0) return { ...defaults };
	const base = Math.min(defaults.reserveTokens, Math.max(1, Math.floor(window / 8)));
	const need = thinkingBudgetTokens(model, thinking) + ANSWER_ROOM_TOKENS + CONTEXT_CLAMP_TOKENS;
	const sixth = Math.floor(window / 6);
	const summaryRoom = sixth >= SUMMARY_ROOM_MIN_RESERVE_TOKENS ? SUMMARY_ROOM_RESERVE_TOKENS : 0;
	const wanted = thinking ? Math.max(need, summaryRoom) : summaryRoom;
	return {
		enabled: true,
		reserveTokens: Math.max(base, Math.min(wanted, sixth)),
		keepRecentTokens: Math.min(defaults.keepRecentTokens, Math.max(1, Math.floor(window / 4))),
	};
}

/**
 * Tokens a request must leave free in its window to be worth sending: the answer room and the output clamp's margin that
 * the reserve holds, without the thinking budget it also holds. It is never more than the reserve itself (a small
 * window's reserve is already less than that) or the model's own output limit (`maxOutputTokens`, when known). A request
 * past the threshold but within this still gets a reply, with less room to think.
 */
export function replyFloorTokens(reserveTokens: number, maxOutputTokens?: number): number {
	const floor = Math.min(reserveTokens, ANSWER_ROOM_TOKENS + CONTEXT_CLAMP_TOKENS);
	return maxOutputTokens !== undefined && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
		? Math.min(floor, maxOutputTokens)
		: floor;
}

/**
 * The most a standalone summary request (compaction, split-turn prefix, branch summary) may write: twice the reserve the
 * policy keeps for the reply, so a summary up to about 2.5 times what fits inline (`inlineSummaryTokens`) still ends
 * and is saved to a file, while one that would run on to the model's own output limit stops. A summary that hits it
 * fails and saves nothing (`getSummarizationFailure`); it is never cut. A thinking budget is added on top of it.
 */
export const SUMMARY_MAX_OUTPUT_TOKENS = 2 * DEFAULT_RESERVE_TOKENS;

/** The highest thinking level a standalone summary request uses: a summary restates, it does not solve. */
export const SUMMARY_THINKING_CEILING = "low" satisfies ModelThinkingLevel;

const THINKING_ORDER: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The thinking level of a standalone summary request: the session's, at most {@link SUMMARY_THINKING_CEILING}. */
export function summaryThinkingLevel<T extends ModelThinkingLevel>(level: T | undefined): T | undefined {
	if (level === undefined) return undefined;
	const ceiling = THINKING_ORDER.indexOf(SUMMARY_THINKING_CEILING);
	return THINKING_ORDER.indexOf(level) > ceiling ? (SUMMARY_THINKING_CEILING as T) : level;
}

/** The output cap of a standalone summary request to `model`: {@link SUMMARY_MAX_OUTPUT_TOKENS}, within the model's own. */
export function summaryMaxTokens(model: { maxTokens?: number }): number {
	const own = model.maxTokens;
	return own !== undefined && Number.isFinite(own) && own > 0
		? Math.min(SUMMARY_MAX_OUTPUT_TOKENS, own)
		: SUMMARY_MAX_OUTPUT_TOKENS;
}
