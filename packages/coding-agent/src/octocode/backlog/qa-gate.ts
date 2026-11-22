import type { FeatureContext } from "../../core/features/index.ts";
import type { Item } from "./item.ts";

/** `backlog.qa`: which items a reviewer checks before `done` completes them. */
export type QaMode = "important" | "all" | "off";

/** What the reviewer answers, in the words of the `octocode-code-review` skill: ready, changes required, verification incomplete. */
export const QA_VERDICTS = ["Ready", "Changes required", "Verification incomplete"] as const;
export type QaVerdictWord = (typeof QA_VERDICTS)[number];

interface QaVerdict {
	verdict: QaVerdictWord;
	summary: string;
	findings: string[];
}

/** What the reviewer is given of the completion a holder reports. */
export interface QaRequest {
	ref: string;
	title: string;
	goal: string;
	summary: string;
	verification: string;
	files: string[];
	/** The pull request the item links, when it links one: the review then follows the pull-request skill. */
	pullRequest?: string;
}

const PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

/** The first GitHub pull request among an item's external links. */
export function linkedPullRequest(links: Item["links"]): string | undefined {
	for (const link of links)
		if (link.target?.resource === "external" && PULL_REQUEST_URL.test(link.target.url)) return link.target.url;
	return undefined;
}

/** A verdict with the model that gave it and what the review cost, or why no review ran (the item then completes with that note). */
export type QaReview = { verdict: QaVerdict; model: string; cost: number } | { skipped: string };

/** Runs one review; never rejects for an expected cause (no small model, a failed child): those are `skipped`. */
export type QaReviewer = (request: QaRequest, ctx: FeatureContext, signal?: AbortSignal) => Promise<QaReview>;

/** Items checked by `important`: a p0 or p1 feature or bug. Research and epics never are; `all` adds the rest except epics. */
const IMPORTANT_TYPES: readonly string[] = ["feature", "bug"];

export function qaRequired(item: Pick<Item, "type" | "priority">, mode: QaMode): boolean {
	if (mode === "off" || item.type === "epic") return false;
	if (mode === "all") return true;
	return IMPORTANT_TYPES.includes(item.type) && item.priority <= 1;
}

const bullets = (findings: readonly string[]): string => findings.map((finding) => `- ${finding}`).join("\n");

/** The note a review leaves on the item: the verdict, the model and its cost, the summary and every finding. */
function qaNote(review: Extract<QaReview, { verdict: QaVerdict }>): string {
	const { verdict, model, cost } = review;
	const head = `QA ${verdict.verdict} (${model}, $${cost.toFixed(4)}): ${verdict.summary}`;
	return verdict.findings.length ? `${head}\n${bullets(verdict.findings)}` : head;
}

/** The refusal a holder reads when QA sends the item back: what was found and where the item went. */
function refusal(ref: string, review: Extract<QaReview, { verdict: QaVerdict }>): string {
	const { verdict } = review.verdict;
	const found = review.verdict.findings.length ? `\n${bullets(review.verdict.findings)}` : "";
	const cost = `(${review.model}, $${review.cost.toFixed(4)})`;
	if (verdict === "Changes required")
		return `${ref} was not completed: QA found changes required ${cost}: ${review.verdict.summary}${found}\nThe item stays ongoing: fix these, then mark it done again.`;
	return `${ref} was not completed: QA could not verify it ${cost}: ${review.verdict.summary}${found}\nThe item went back to the backlog with your claim released: run the missing checks (or have them run), then claim and complete it again.`;
}

/** The write that sends an item back: a note, and for verification incomplete the backlog state (which also releases the claim). */
export type QaSendBack = (ref: string, state: "ongoing" | "backlog", note: string) => Promise<void>;

/**
 * Applies a review before the completion is written; only a session that is not a subagent runs one (a subagent may not move an item to the backlog). A pass returns the note to record with the completion; a skip
 * returns a note saying so; changes required and verification incomplete write their note through `sendBack`, then
 * throw the refusal the holder reads (so the holder is told in the same call that asked).
 */
export async function applyReview(item: Item, review: QaReview, sendBack: QaSendBack): Promise<string> {
	if ("skipped" in review) return `QA skipped: ${review.skipped}`;
	const note = qaNote(review);
	if (review.verdict.verdict === "Ready") return note;
	await sendBack(item.ref, review.verdict.verdict === "Verification incomplete" ? "backlog" : "ongoing", note);
	throw new Error(refusal(item.ref, review));
}
