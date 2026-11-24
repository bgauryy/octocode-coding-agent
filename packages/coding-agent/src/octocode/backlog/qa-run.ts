import type { FeatureContext } from "../../core/features/index.ts";
import type { Backlog } from "./context.ts";
import type { Item } from "./item.ts";
import { applyReview, linkedPullRequest, type QaMode, qaRequired, type QaReviewer } from "./qa-gate.ts";
import { readBaseline } from "./qa-baseline.ts";
import { evidenceLine } from "./receipts.ts";
import { completionInput } from "./tool-arguments.ts";
import { runBacklog } from "./tool-run.ts";
import { oneWrite } from "./tool-support.ts";

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
 * while the review runs it is ongoing and the reviewer child shows as its worker.
 */
export async function reviewBeforeDone(
	backlog: Backlog,
	item: Item,
	completion: unknown,
	mode: QaMode,
	review: QaReviewer,
	ctx: FeatureContext,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (completion === undefined || mode === "off") return undefined;
	const given = completionInput(completion);
	if (!qaRequired(item, mode, admitsGap(given.summary) ? "not_stated" : given.verification.status)) return undefined;
	const receipt = given.receipt === undefined ? undefined : backlog.receipts?.(given.receipt);
	const baseline = await readBaseline(ctx.cwd, item.ref);
	const outcome = await review(
		{
			ref: item.ref,
			title: item.title,
			goal: item.goal,
			summary: given.summary,
			verification: `${given.verification.summary} (status: ${given.verification.status})${receipt ? `\n${evidenceLine({ receipt })}` : ""}`,
			...(receipt ? { receipt } : {}),
			files: given.files.map((file) => file.path),
			pullRequest: linkedPullRequest(item.links),
			...(baseline ? { baseline } : {}),
		},
		ctx,
		signal,
	);
	signal?.throwIfAborted();
	return applyReview(item, outcome, (ref, state, note) =>
		oneWrite(async () => {
			await backlog.store.transactionWhenReady(
				() => runBacklog(backlog, { op: "update", id: ref, state, note }, { subagent: false, word: "done" }),
				signal,
			);
		}),
	);
}
