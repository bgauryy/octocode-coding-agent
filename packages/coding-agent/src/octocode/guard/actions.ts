import { renderList, sortReviews } from "./report.ts";
import { visible } from "./visible.ts";
import { decide, forget, type GuardOptions, resolveReviews, ReviewRefusedError } from "./store.ts";
import { badge, REVIEW_KINDS, type Review, type ReviewKind } from "./types.ts";

/**
 * The verbs `/security` and `octocode security` share. Each works on the reviews the loaders produced and re-reads the
 * stored decisions first, so a decision made elsewhere (another session, the web page) shows at once.
 */

export const SECURITY_VERBS = ["list", "show", "check", "approve", "deny", "forget"] as const;

/** The kinds `--kind` names, in the setting's words. */
const KIND_NAMES: Partial<Record<string, ReviewKind>> = {
	hooks: "hook",
	hook: "hook",
	mcp: "mcp",
	skills: "skill",
	skill: "skill",
};

export class SecurityCommandError extends Error {}

/** The reviews with the stored decisions read again. */
export function refreshed(reviews: readonly Review[], options: GuardOptions = {}): Review[] {
	return resolveReviews(
		reviews.map((review) => review.item),
		options,
	);
}

/** The review `id` names: its exact id, or a label only one item has. */
export function findReview(reviews: readonly Review[], id: string): Review {
	const exact = reviews.find((review) => review.item.id === id);
	if (exact) return exact;
	const named = reviews.filter((review) => review.item.label === id);
	if (named.length === 1 && named[0]) return named[0];
	if (named.length > 1)
		throw new SecurityCommandError(
			`${id} names ${named.length} items; use an id: ${named.map((review) => review.item.id).join(", ")}`,
		);
	throw new SecurityCommandError(`No hook, MCP server or skill ${id} was found. /security list shows the ids.`);
}

/** `--kind hooks,mcp` as review kinds; every kind when absent. */
export function parseKinds(value: string | undefined): ReviewKind[] {
	if (value === undefined) return [...REVIEW_KINDS];
	const kinds: ReviewKind[] = [];
	for (const word of value.split(",")) {
		const kind = KIND_NAMES[word.trim()];
		if (!kind) throw new SecurityCommandError(`--kind takes hooks, mcp or skills (comma-separated), not ${value}.`);
		kinds.push(kind);
	}
	return kinds;
}

/** The `check` table: every item that is not approved, highest rating first, with its findings. */
export function checkTable(reviews: readonly Review[]): string {
	const waiting = sortReviews(reviews).filter((review) => review.word !== "approved");
	if (waiting.length === 0) return "Nothing is waiting: every item found is approved.";
	return waiting
		.map((review) => {
			const rules = [...new Set(review.findings.map((finding) => finding.rule))];
			return `${badge(review).padEnd(28)} ${visible(review.item.id)}${rules.length ? `  (${rules.join(", ")})` : ""}`;
		})
		.join("\n");
}

/** The list with an enforcement note per kind. */
export function listText(reviews: readonly Review[], enforced: (review: Review) => boolean, filter?: string): string {
	const shown = filter
		? reviews.filter((review) => `${review.item.id} ${review.item.label}`.toLowerCase().includes(filter.toLowerCase()))
		: reviews;
	return renderList(shown, enforced);
}

/** Records one decision and says what it did. */
export function decideOne(
	review: Review,
	verb: "approve" | "deny" | "forget",
	via: string,
	options: GuardOptions = {},
): string {
	const name = visible(review.item.id);
	if (verb === "forget")
		return forget(review, options)
			? `Forgot the decision about ${name}; it is reviewed as new at the next load.`
			: `${name} has no stored decision.`;
	try {
		decide(review, verb === "approve" ? "approved" : "denied", via, options);
	} catch (error) {
		if (error instanceof ReviewRefusedError) throw new SecurityCommandError(error.message);
		throw error;
	}
	return `${verb === "approve" ? "Approved" : "Denied"} ${name} (${review.rating}, sha256 ${review.hash.slice(0, 16)}).`;
}

/**
 * `approve --all`: approves every waiting item of `kinds` at its current content and prints each one. A Critical item
 * and one that was not read in full are never approved this way; they are named so the user can decide them one by one.
 */
export function approveAll(
	reviews: readonly Review[],
	kinds: readonly ReviewKind[],
	via: string,
	options: GuardOptions = {},
) {
	const lines: string[] = [];
	let approved = 0;
	for (const review of sortReviews(reviews)) {
		if (review.word === "approved" || !kinds.includes(review.item.kind)) continue;
		if (review.rating === "CRITICAL" || review.item.unreadable) {
			lines.push(
				`Skipped ${visible(review.item.id)} (${review.rating}${review.item.unreadable ? ", not read in full" : ""}): approve it by its id after reading its report.`,
			);
			continue;
		}
		lines.push(decideOne(review, "approve", via, options));
		approved += 1;
	}
	if (lines.length === 0) lines.push("Nothing is waiting.");
	return { lines, approved };
}
