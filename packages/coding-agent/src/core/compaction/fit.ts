/**
 * Fit a compaction to the window it is for, before any summary is requested. The kept tail is sized by
 * `keepRecentTokens`, but after a switch to a smaller model the prompt, tools and that tail can fill the new window on
 * their own; a summary paid for then could never be saved. The tail then shrinks (more of it is summarized) until the
 * retained context leaves room for a summary, or the compaction fails here with what the user can do.
 */

import type { TokenModel } from "@octocodeai/octocode-ai/utils/estimate";
import type { SessionEntry } from "../session-manager.ts";
import { inlineSummaryTokens, projectAfterCompaction, summaryTargetTokens } from "./checkpoint.ts";
import { type CompactionPreparation, prepareCompaction } from "./compaction.ts";
import { replyFloorTokens } from "./settings.ts";

/** The compaction cannot fit the target window whatever it keeps; raised before any model call. */
export class CompactionFitError extends Error {}

/** Shrink steps before the tail drops to its minimum (the newest turn); each step at least halves the budget. */
const SHRINK_STEPS = 12;

/** Room for the least a checkpoint can be: the reference to its saved file, or a clipped summary without a file. */
const MIN_SUMMARY_TOKENS = 128;

/**
 * Room the summary needs next to the retained context: {@link MIN_SUMMARY_TOKENS}, less when the reserve or the window
 * is that small. A longer summary is saved to a file or clipped when it is finalized.
 */
function summaryRoomTokens(reserveTokens: number, available: number): number {
	const target = reserveTokens > 0 ? summaryTargetTokens(inlineSummaryTokens(reserveTokens)) : MIN_SUMMARY_TOKENS;
	return Math.max(1, Math.min(MIN_SUMMARY_TOKENS, target, Math.floor(available / 2)));
}

/** What the request after the compaction holds besides what the compaction keeps, and how its tokens are estimated. */
export interface FitTarget {
	/** Estimated tokens of input waiting for this compaction (a prompt not yet on the branch). */
	incomingTokens?: number;
	/** The model the next request goes to: its tokenizer family and output limit (`replyFloorTokens`). */
	model?: TokenModel & { maxTokens?: number };
	/** Summarize a newest turn that already failed when it alone fills the window; not while that turn is being retried. */
	summarizeFailedTurn?: boolean;
}

/**
 * `preparation`, or one that keeps a shorter tail of `branchEntries` when what it keeps leaves no room at all for a
 * summary in `contextWindow` less the reserve, or when the kept part and `target.incomingTokens` would not fit the
 * window with the reply's floor and the summary (`exceedsContextWindow`): the request that waits for the compaction
 * must not need a second one. A shorter tail is sized to leave a checkpoint's least room; a tail that fits already is
 * kept as it is. An unknown window (0 or less) changes nothing. Throws {@link CompactionFitError} when even the newest
 * turn with the prompt and tools leaves no room; input that waits alone too large is the request's to report, not this.
 * With `target.summarizeFailedTurn`, a newest turn that already ended in an error is not kept: it is summarized too, so
 * a session whose prompts fill the window recovers.
 */
export function fitCompactionToWindow(
	branchEntries: SessionEntry[],
	preparation: CompactionPreparation,
	contextWindow: number,
	target: FitTarget = {},
): CompactionPreparation {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return preparation;
	const { settings } = preparation;
	const available = contextWindow - settings.reserveTokens;
	const retainedBy = (candidate: CompactionPreparation) =>
		projectAfterCompaction(branchEntries, candidate.firstKeptEntryId, 0, target.model)("");
	const room = summaryRoomTokens(settings.reserveTokens, available);
	// With input waiting, the most the kept part may take beside it, the reply's floor and the summary the compaction
	// adds (the size an updated summary is asked to stay under).
	const incoming = Math.max(0, target.incomingTokens ?? 0);
	const checkpoint = Math.max(room, summaryTargetTokens(inlineSummaryTokens(settings.reserveTokens)));
	const besideIncoming =
		incoming > 0
			? contextWindow - replyFloorTokens(settings.reserveTokens, target.model?.maxTokens) - incoming - checkpoint
			: Number.POSITIVE_INFINITY;
	let retained = retainedBy(preparation);
	if (retained < available && retained <= besideIncoming) return preparation;
	const limit = Math.min(available - room, besideIncoming);
	let fitted = preparation;
	let keep = settings.keepRecentTokens;
	for (let step = 0; retained > limit && keep > 0; step++) {
		// First by what is over, then by at least half: the tail moves by whole entries, so the estimate can lag.
		const over = retained - limit;
		keep = step >= SHRINK_STEPS ? 0 : Math.max(0, Math.min(keep - over, step > 0 ? Math.floor(keep / 2) : keep));
		const next = prepareCompaction(branchEntries, { ...settings, keepRecentTokens: keep });
		if (!next) break;
		fitted = { ...next, settings };
		retained = retainedBy(fitted);
	}
	if (retained >= available && target.summarizeFailedTurn === true && endsWithFailedTurn(branchEntries)) {
		// The newest turn is oversized and already failed: nothing waits on it whole, so it is summarized with the rest.
		const all = prepareCompaction(branchEntries, settings, { summarizeAll: true });
		if (all) {
			fitted = all;
			retained = retainedBy(fitted);
		}
	}
	if (retained >= available) throw new CompactionFitError(cannotFit(retained, contextWindow, settings.reserveTokens));
	return fitted;
}

/** The branch ends with an assistant reply that failed: the turn before it was answered with an error. */
function endsWithFailedTurn(branchEntries: SessionEntry[]): boolean {
	const last = branchEntries.at(-1);
	return last?.type === "message" && last.message.role === "assistant" && last.message.stopReason === "error";
}

function cannotFit(retained: number, contextWindow: number, reserveTokens: number): string {
	return (
		`the system prompt, tools and newest turn alone take about ${retained.toLocaleString("en-US")} tokens, ` +
		`which leaves no room for a summary in this model's ${contextWindow.toLocaleString("en-US")}-token window ` +
		`(${reserveTokens.toLocaleString("en-US")} reserved for the reply). Switch to a model with a larger window, ` +
		"or start a new session with /new."
	);
}
