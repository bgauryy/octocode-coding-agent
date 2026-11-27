import type { Completion } from "@octocodeai/octocode-contracts/backlogs";
import type { FeatureContext } from "../../core/features/index.ts";
import { harnessSource } from "../events/source.ts";
import type { Backlog } from "./context.ts";
import type { Item } from "./item.ts";
import { linkedPullRequest, qaNote, type QaReviewer, sendBackState } from "./qa-gate.ts";
import { sendBackOf } from "./qa-send-back.ts";
import { qaVerification } from "./receipts.ts";

/** The topic a review owed because no reviewer could start is recorded under. */
const UNAVAILABLE_TOPIC = "qa.unavailable";
/** How many owed reviews one successful reviewer start works through; the rest wait for the next start, so a `done` stays quick. */
const OWED_PER_START = 5;
/** The text an owed completion's JSON holds: the store's text search finds the candidates, the filter below confirms them. */
const OWED_MARK = '"qa":"owed"';
const OWED_SCAN = 500;

/** Records that `item` completed with its review owed, for hooks and the web view (one row per item version). */
export function recordUnavailable(backlog: Backlog, item: Item, cause: string, signal?: AbortSignal): Promise<void> {
	const at = Date.now();
	const source = harnessSource("backlog");
	return backlog.store.recordEvent(
		{
			at,
			topic: UNAVAILABLE_TOPIC,
			key: `qa-unavailable:${item.ref}`,
			source: JSON.stringify(source),
			payload: JSON.stringify({ item: item.ref, cause }),
			digest: `QA owed on ${item.ref}: ${cause}`,
			dedupeKey: `${UNAVAILABLE_TOPIC}:${item.ref}:${item.version}`,
		},
		signal,
	);
}

/** Done items whose latest completion owes its review, oldest first. */
function owedItems(backlog: Backlog): Item[] {
	return backlog.store
		.list({ states: ["done"], query: OWED_MARK, limit: OWED_SCAN })
		.items.filter((item) => item.completions.at(-1)?.qa === "owed")
		.sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0) || a.rowId - b.rowId);
}

/** The completion as a correction that no longer owes its review: the same content, a key of its own, the receipt facts kept. */
function settled(completion: Completion): NonNullable<Parameters<Backlog["store"]["update"]>[1]["completion"]> {
	const { id, actor: _actor, at: _at, version: _version, goal: _goal, qa: _qa, ...content } = completion;
	return { ...content, operationKey: `qa-rerun-${id}` };
}

/**
 * Called when a reviewer has just started and answered: reviews the items whose review is owed, oldest first and one at a
 * time (at most `OWED_PER_START`). A Ready verdict records the review on the item and clears the debt; any other verdict
 * sends the item back like an ordinary QA failure. Stops at the first review that cannot run. Returns the lines to show
 * the caller, empty when nothing was owed.
 */
export async function reviewOwed(
	backlog: Backlog,
	review: QaReviewer,
	ctx: FeatureContext,
	skip: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const owed = owedItems(backlog).filter((item) => item.ref !== skip);
	const lines: string[] = [];
	const sendBack = sendBackOf(backlog, signal);
	for (const item of owed.slice(0, OWED_PER_START)) {
		signal?.throwIfAborted();
		const completion = item.completions.at(-1)!;
		const outcome = await review(
			{
				ref: item.ref,
				title: item.title,
				goal: item.goal,
				summary: completion.summary,
				verification: qaVerification(completion.verification, completion.receipt),
				...(completion.receipt ? { receipt: completion.receipt } : {}),
				files: completion.files.map((file) => file.path),
				pullRequest: linkedPullRequest(item.links),
			},
			ctx,
			signal,
		);
		if (!("verdict" in outcome)) {
			const why = "unavailable" in outcome ? outcome.unavailable : outcome.skipped;
			lines.push(`${owed.length - lines.length} owed review(s), from ${item.ref}, still wait: ${why}`);
			return lines;
		}
		const note = `Owed review, now run. ${qaNote(outcome)}`;
		const word = outcome.verdict.verdict;
		if (word === "Ready") {
			await backlog.store.transactionWhenReady(
				() => backlog.store.update(item.ref, { note, completion: settled(completion) }, backlog.actor),
				signal,
			);
			lines.push(`${item.ref}: owed QA review ran, Ready`);
		} else {
			await sendBack(item.ref, sendBackState(word), note);
			lines.push(`${item.ref}: owed QA review ran, ${word}: the item was reopened (see its note)`);
		}
	}
	if (owed.length > OWED_PER_START)
		lines.push(`${owed.length - OWED_PER_START} more owed review(s) wait for the next reviewer start.`);
	return lines;
}
