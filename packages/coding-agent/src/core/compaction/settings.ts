import type { ModelThinkingLevel, ThinkingBudgets } from "@octocodeai/octocode-ai";
import {
	CONTEXT_SAFETY_TOKENS as CONTEXT_CLAMP_TOKENS,
	thinkingBudgetForLevel,
} from "@octocodeai/octocode-ai/api/simple-options";
import { tokensOfWindow } from "../limits.ts";
import { DEFAULT_RESERVE_TOKENS, SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** Tokens kept for the visible answer next to the thinking budget. */
const ANSWER_ROOM_TOKENS = 8192;

/** The part of a model the policy reads. */
export interface CompactionModel {
	contextWindow?: number;
	inputLimits?: { maxInputTokens?: number };
	reasoning?: boolean;
	compat?: unknown;
}

/** The `limits.compaction` values in force for the model (`resolveLimits`). */
export interface CompactionLimits {
	trigger?: number;
	keepRecent?: number;
}

/** The share of the window kept as recent messages when `limits.compaction.keepRecent` names none. */
const KEEP_RECENT_SHARE = 0.1;

/** Prompt room after reserving output in the combined window and applying any independent input ceiling. */
export function inputRoomTokens(contextWindow: number, reserveTokens: number, maxInputTokens?: number): number {
	return Math.max(0, Math.min(contextWindow - reserveTokens, maxInputTokens ?? Infinity));
}

/**
 * Context size past which automatic compaction starts: the room the reserve leaves, or the configured
 * `triggerTokens` when that is lower. The trigger never raises the point: the reserve holds the reply and the summary.
 */
export function compactionThresholdTokens(
	contextWindow: number,
	settings: { reserveTokens: number; maxInputTokens?: number; triggerTokens?: number },
): number {
	return Math.min(
		inputRoomTokens(contextWindow, settings.reserveTokens, settings.maxInputTokens),
		settings.triggerTokens ?? Infinity,
	);
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
 * Preserve space for the checkpoint instructions and reply as a turn crosses the threshold. The shared summary
 * can lower its output ceiling when the checkpoint target still fits after the provider's safety margin.
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
 *
 * The recent tail is `limits.keepRecent`, else a tenth of the window and at least the default, within a quarter of the
 * window either way. `limits.trigger` becomes `triggerTokens`, never below twice the tail: a compaction that frees
 * less than it keeps would run again at once.
 */
export function builtInCompactionSettings(
	model?: CompactionModel,
	thinking?: CompactionThinking,
	limits?: CompactionLimits,
) {
	const defaults = SETTINGS_DEFAULTS.compaction;
	const window = model?.contextWindow;
	if (window === undefined || !Number.isFinite(window) || window <= 0) return { ...defaults };
	const base = Math.min(defaults.reserveTokens, Math.max(1, Math.floor(window / 8)));
	const need = thinkingBudgetTokens(model, thinking) + ANSWER_ROOM_TOKENS + CONTEXT_CLAMP_TOKENS;
	const sixth = Math.floor(window / 6);
	const summaryRoom = sixth >= SUMMARY_ROOM_MIN_RESERVE_TOKENS ? SUMMARY_ROOM_RESERVE_TOKENS : 0;
	const wanted = thinking ? Math.max(need, summaryRoom) : summaryRoom;
	const tail =
		limits?.keepRecent === undefined
			? Math.max(defaults.keepRecentTokens, Math.floor(window * KEEP_RECENT_SHARE))
			: tokensOfWindow(limits.keepRecent, window);
	const keepRecentTokens = Math.max(1, Math.min(tail, Math.floor(window / 4)));
	return {
		enabled: true,
		...(model?.inputLimits?.maxInputTokens ? { maxInputTokens: model.inputLimits.maxInputTokens } : {}),
		...(limits?.trigger === undefined
			? {}
			: { triggerTokens: Math.max(tokensOfWindow(limits.trigger, window), 2 * keepRecentTokens) }),
		reserveTokens: Math.max(base, Math.min(wanted, sixth)),
		keepRecentTokens,
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
