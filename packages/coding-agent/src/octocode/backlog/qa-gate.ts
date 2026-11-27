import type { FeatureContext } from "../../core/features/index.ts";
import type { Item } from "./item.ts";
import { type CompletionReceipt, QA_OWED_PREFIX, QA_SKIPPED_PREFIX } from "./receipts.ts";

/** `backlog.qa`: which items a reviewer checks before `done` completes them. */
export type QaMode = "important" | "all" | "off";

/** What the reviewer answers, in the words of the `octocode-code-review` skill: ready, changes required, verification incomplete. */
export const QA_VERDICTS = ["Ready", "Changes required", "Verification incomplete"] as const;
export type QaVerdictWord = (typeof QA_VERDICTS)[number];

interface QaVerdict {
	verdict: QaVerdictWord;
	summary: string;
	/** Defects in the item's own changes: what makes the verdict. */
	findings: string[];
	/** What the reviewer saw that is not the item's doing (other agents' edits, failures they caused): named, never a blocker. */
	context?: string[];
	/** The reviewer's own closing notes (Noticed, For coordinator, Ask user), when it wrote any. */
	notes?: string;
}

/** What the reviewer is given of the completion a holder reports. */
export interface QaRequest {
	ref: string;
	title: string;
	goal: string;
	summary: string;
	verification: string;
	/** What the shell receipt the completion cites showed, when it cites one; also stated in `verification`. */
	receipt?: CompletionReceipt;
	files: string[];
	/** The pull request the item links, when it links one: the review then follows the pull-request skill. */
	pullRequest?: string;
	/** The working tree (a git tree id) when the item was claimed: the review judges what changed since, not what was there before. */
	baseline?: string;
}

const PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

/** The first GitHub pull request among an item's external links. */
export function linkedPullRequest(links: Item["links"]): string | undefined {
	for (const link of links)
		if (link.target?.resource === "external" && PULL_REQUEST_URL.test(link.target.url)) return link.target.url;
	return undefined;
}

/**
 * A verdict with the model that gave it and what the review cost, or why no review ran (the item then completes with that
 * note): `skipped` when QA is not configured (no small model), `unavailable` when a reviewer was due but could not start or
 * finish (the review is then owed and reruns when one can).
 */
export type QaReview =
	| { verdict: QaVerdict; model: string; cost: number }
	| { skipped: string }
	| { unavailable: string };

/** A review that gave a verdict. */
export type QaVerdictReview = Extract<QaReview, { verdict: QaVerdict }>;

/** Runs one review; never rejects for an expected cause: no small model is `skipped`, a reviewer that cannot start or times out is `unavailable`. */
export type QaReviewer = (request: QaRequest, ctx: FeatureContext, signal?: AbortSignal) => Promise<QaReview>;

/** Items checked by `important`: a p0 or p1 feature or bug. Research and epics never are; `all` adds the rest except epics. */
const IMPORTANT_TYPES: readonly string[] = ["feature", "bug"];

/** The verification statuses that state a pass, or that no check applies: any other leaves the completion without a stated pass. */
const CLEAN_STATUSES: readonly string[] = ["passed", "not_applicable"];

/**
 * The one rule for when QA runs on a `done` that carries a completion: never in mode `off` and never for an epic; in
 * mode `all` always; in mode `important` for a p0 or p1 feature or bug, and for any item whose verification does not
 * state a pass (failed, not run or not stated), so a completion that admits a gap is never waved through unreviewed.
 */
export function qaRequired(
	item: Pick<Item, "type" | "priority">,
	mode: QaMode,
	verificationStatus: string = "passed",
): boolean {
	if (mode === "off" || item.type === "epic") return false;
	if (mode === "all") return true;
	if (!CLEAN_STATUSES.includes(verificationStatus)) return true;
	return IMPORTANT_TYPES.includes(item.type) && item.priority <= 1;
}

/** What the reviewer named as not this item's doing, one list after the findings. */
const contextLines = (verdict: QaVerdict): string =>
	verdict.context?.length ? `\nContext, not blocking:\n${bullets(verdict.context)}` : "";

const bullets = (findings: readonly string[]): string => findings.map((finding) => `- ${finding}`).join("\n");

/** The note a review leaves on the item: the verdict, the model and its cost, the summary and every finding. */
export function qaNote(review: QaVerdictReview): string {
	const { verdict, model, cost } = review;
	const head = `QA ${verdict.verdict} (${model}, $${cost.toFixed(4)}): ${verdict.summary}`;
	const found = verdict.findings.length ? `\n${bullets(verdict.findings)}` : "";
	const notes = verdict.notes ? `\nReviewer notes:\n${verdict.notes}` : "";
	return `${head}${found}${contextLines(verdict)}${notes}`;
}

/** The refusal a holder reads when QA sends the item back: what was found and where the item went. */
function refusal(ref: string, review: QaVerdictReview, version?: number): string {
	const { verdict } = review.verdict;
	const found = `${review.verdict.findings.length ? `\n${bullets(review.verdict.findings)}` : ""}${contextLines(review.verdict)}`;
	const cost = `(${review.model}, $${review.cost.toFixed(4)})`;
	// The send-back note bumped the item's version: a retry with the version read before the review would be refused as stale.
	const now = version === undefined ? "" : ` The item is now at version ${version}: pass that, or none.`;
	if (verdict === "Changes required")
		return `${ref} was not completed: QA found changes required ${cost}: ${review.verdict.summary}${found}\nThe item stays ongoing: fix these, then mark it done again.${now}`;
	return `${ref} was not completed: QA could not verify it ${cost}: ${review.verdict.summary}${found}\nThe item went back to the backlog with your claim released: run the missing checks (or have them run), then claim and complete it again.${now}`;
}

/** Where a verdict that is not Ready sends the item: back to the holder to fix, or to the backlog when verification is incomplete. */
export const sendBackState = (verdict: QaVerdictWord): "ongoing" | "backlog" =>
	verdict === "Verification incomplete" ? "backlog" : "ongoing";

/** The note of a review owed because no reviewer could start: says the cause and what happens next. */
const owedNote = (cause: string): string =>
	`${QA_OWED_PREFIX} the independent review did not run (${cause}); it reruns when a reviewer can start. The item is done on the holder's word until then.`;

/** The write that sends an item back: a note, and for verification incomplete the backlog state (which also releases the claim). */
export type QaSendBack = (ref: string, state: "ongoing" | "backlog", note: string) => Promise<number | undefined>;

/**
 * Applies a review before the completion is written; only a session that is not a subagent runs one (a subagent may not move an item to the backlog). A pass returns the note to record with the completion; a skip
 * or an unavailable reviewer returns a note saying so (the latter marks the review owed and never blocks the item); changes required and verification incomplete write their note through `sendBack`, then
 * throw the refusal the holder reads (so the holder is told in the same call that asked).
 */
export async function applyReview(item: Item, review: QaReview, sendBack: QaSendBack): Promise<string> {
	if ("skipped" in review)
		return `${QA_SKIPPED_PREFIX} UNVERIFIED, no independent review ran (${review.skipped}). The item is done on the holder's word.`;
	if ("unavailable" in review) return owedNote(review.unavailable);
	const note = qaNote(review);
	if (review.verdict.verdict === "Ready") return note;
	const version = await sendBack(item.ref, sendBackState(review.verdict.verdict), note);
	throw new Error(refusal(item.ref, review, version));
}
