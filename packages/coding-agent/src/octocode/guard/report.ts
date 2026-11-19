import { renderChanges } from "./diff.ts";
import { visible } from "./visible.ts";
import { badge, RATINGS, type Review, type ReviewWord } from "./types.ts";

/**
 * The text every surface shows: the report of one item and the list of all of them. The guard renders it, never the
 * model. It says what was checked and never calls an item safe. Hidden characters in item text are shown as `[U+XXXX]`.
 */

const KIND_WORDS = { hook: "hook", mcp: "MCP server", skill: "skill" } as const;

/** The report of one item: what it is, its state and rating, the findings worst first, and what approval grants. */
export function renderReport(review: Review): string {
	const { item } = review;
	const findings = review.findings.length
		? review.findings.map(
				(finding, index) => `${index + 1}. [${finding.rating}] ${finding.rule}  ${visible(finding.text)}`,
			)
		: ["none"];
	return [
		`Review: ${visible(item.label)}  (${KIND_WORDS[item.kind]}, ${item.scope === "global" ? "your files" : "this repository"}, ${visible(item.path)})`,
		`Id:       ${visible(item.id)}`,
		`State:    ${badge(review)}${review.changed ? " (approved content changed since)" : ""}`,
		`Rating:   ${review.rating}`,
		`Coverage: static scan of ${item.files.length} file${item.files.length === 1 ? "" : "s"} · origin not looked up${item.unreadable ? ` · not read in full: ${item.unreadable}` : ""}`,
		"",
		"Findings, most severe first:",
		...findings,
		"",
		`If approved it gets: ${item.grants.join(" · ")}`,
		`Content: sha256 ${review.hash.slice(0, 16)}`,
		...(review.changed && review.approved
			? ["", "Changed since you approved it (- removed, + added):", ...renderChanges(review.approved, item.files)]
			: []),
	].join("\n");
}

const WORD_ORDER: Record<ReviewWord, number> = { "not checked": 0, approved: 1, denied: 2 };
const RANK = (review: Review) => RATINGS.length - RATINGS.indexOf(review.rating);

/** Not checked first (changed, then highest rating), then approved, then denied. */
export function sortReviews(reviews: readonly Review[]): Review[] {
	return [...reviews].sort(
		(a, b) =>
			WORD_ORDER[a.word] - WORD_ORDER[b.word] ||
			Number(b.changed) - Number(a.changed) ||
			RANK(a) - RANK(b) ||
			a.item.id.localeCompare(b.item.id),
	);
}

/** The list as a table, one row per item with its id. */
export function renderList(reviews: readonly Review[], enforced: (review: Review) => boolean): string {
	if (reviews.length === 0) return "No hooks, MCP servers or skills from outside Octocode were found.";
	const lines: string[] = [];
	for (const word of ["not checked", "approved", "denied"] as const) {
		const rows = sortReviews(reviews).filter((review) => review.word === word);
		if (!rows.length) continue;
		lines.push(`${word[0]?.toUpperCase()}${word.slice(1)} (${rows.length})`);
		for (const review of rows)
			lines.push(
				`  ${visible(review.item.label).slice(0, 40).padEnd(40)}  ${KIND_WORDS[review.item.kind].padEnd(10)}  ${badge(review)}${word !== "approved" && !enforced(review) ? " (loads: not enforced)" : ""}  ${visible(review.item.id)}`,
			);
	}
	return lines.join("\n");
}
