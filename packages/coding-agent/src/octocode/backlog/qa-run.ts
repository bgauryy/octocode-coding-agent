import type { FeatureContext } from "../../core/features/index.ts";
import type { Backlog } from "./context.ts";
import type { Item } from "./item.ts";
import { applyReview, linkedPullRequest, type QaMode, type QaReview, qaRequired, type QaReviewer } from "./qa-gate.ts";
import { readBaseline } from "./qa-baseline.ts";
import { recordUnavailable, reviewOwed } from "./qa-owed.ts";
import { sendBackOf } from "./qa-send-back.ts";
import { qaVerification } from "./receipts.ts";
import { completionInput } from "./tool-arguments.ts";

/**
 * Phrasings by which a holder admits the goal is unmet: the goal named as not met, a leading "not done" or "incomplete",
 * "partially implemented", or work it could not finish. A mere mention ("partial coverage is a known gap", "nothing
 * partial remains") is not an admission.
 */
const GAP = new RegExp(
	[
		"\\bgoal (?:is |was )?(?:not|un) ?(?:yet |fully )?(?:met|achieved)\\b",
		"\\bgoal unmet\\b",
		"^\\s*(?:not done|not finished|incomplete|unfinished|gap:)",
		"\\bpartially (?:done|implemented|met|complete[d]?|fixed|finished)\\b",
		"\\bonly partly\\b",
		"\\bnot (?:yet|fully) (?:implemented|finished|done|met|complete[d]?)\\b",
		"\\b(?:could not|couldn't|did not|didn't|was not able to) (?:fully )?(?:meet|finish|complete|implement|achieve|fix)\\b",
	].join("|"),
	"i",
);

/** True when the completion summary admits the goal is not (fully) met: such a completion is reviewed whatever the item's priority. */
export const admitsGap = (summary: string): boolean => GAP.test(summary);

/**
 * The QA step of `done`, before the completion is written: for an item the mode covers, a reviewer reads the reported
 * completion. Returns the note to record with the completion (the verdict, or why none ran), undefined when the item
 * is not covered; throws, after noting the findings, when the reviewer sends the item back. The item has no new state:
 * while the review runs it stays ongoing, held by the holder; the reviewer child carries no item.
 */
export async function reviewBeforeDone(
	backlog: Backlog,
	item: Item,
	completion: unknown,
	mode: QaMode,
	review: QaReviewer,
	ctx: FeatureContext,
	signal?: AbortSignal,
	/** `started`: a review of this completion already under way (a batch starts them ahead); `reviewing` is told when one is awaited. */
	options: { started?: Promise<QaReview | undefined>; reviewing?: () => void } = {},
): Promise<string | undefined> {
	if (!coveredCompletion(item, completion, mode)) return undefined;
	options.reviewing?.();
	const outcome = await (options.started ?? requestReview(backlog, item, completion, mode, review, ctx, signal));
	if (!outcome) return undefined;
	signal?.throwIfAborted();
	// A reviewer that cannot start owes the review: the event says so for hooks and the web view; `done` goes on.
	if ("unavailable" in outcome) await recordUnavailable(backlog, item, outcome.unavailable, signal);
	// A reviewer that just answered proves one can start: the reviews owed from earlier outages run now.
	const reran = "verdict" in outcome ? await reviewOwed(backlog, review, ctx, item.ref, signal) : [];
	const note = await applyReview(item, outcome, sendBackOf(backlog, signal));
	return reran.length ? `${note}\n${reran.join("\n")}` : note;
}

/** The completion as the holder gave it, when the mode covers this item's review; undefined when it does not. */
export function coveredCompletion(item: Item, completion: unknown, mode: QaMode) {
	if (completion === undefined || mode === "off") return undefined;
	const given = completionInput(completion);
	return qaRequired(item, mode, admitsGap(given.summary) ? "not_stated" : given.verification.status)
		? given
		: undefined;
}

/** Runs the review of a covered completion (undefined when the mode does not cover it); the item is not touched. */
export async function requestReview(
	backlog: Backlog,
	item: Item,
	completion: unknown,
	mode: QaMode,
	review: QaReviewer,
	ctx: FeatureContext,
	signal?: AbortSignal,
): Promise<QaReview | undefined> {
	const given = coveredCompletion(item, completion, mode);
	if (!given) return undefined;
	const receipt = given.receipt === undefined ? undefined : backlog.receipts?.(given.receipt);
	const baseline = await readBaseline(ctx.cwd, item.ref);
	return review(
		{
			ref: item.ref,
			title: item.title,
			goal: item.goal,
			summary: given.summary,
			verification: qaVerification(given.verification, receipt),
			...(receipt ? { receipt } : {}),
			files: given.files.map((file) => file.path),
			pullRequest: linkedPullRequest(item.links),
			...(baseline ? { baseline } : {}),
		},
		ctx,
		signal,
	);
}
