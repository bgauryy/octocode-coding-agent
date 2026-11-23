import type { FeatureContext } from "../../core/features/index.ts";
import type { Backlog } from "./context.ts";
import type { Item } from "./item.ts";
import { applyReview, linkedPullRequest, type QaMode, qaRequired, type QaReviewer } from "./qa-gate.ts";
import { evidenceLine } from "./receipts.ts";
import { completionInput } from "./tool-arguments.ts";
import { runBacklog } from "./tool-run.ts";
import { oneWrite } from "./tool-support.ts";

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
	if (!qaRequired(item, mode) || completion === undefined) return undefined;
	const given = completionInput(completion);
	const receipt = given.receipt === undefined ? undefined : backlog.receipts?.(given.receipt);
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
