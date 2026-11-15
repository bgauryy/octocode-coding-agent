/**
 * The extension guard: what a session loads that Octocode did not ship (a hook, an MCP server, a skill) stays off until
 * the user has checked it and approved its exact content. The user-facing name is "security" (`/security`,
 * `octocode security`); this folder keeps the internal name.
 */

export const REVIEW_KINDS = ["hook", "mcp", "skill"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const RATINGS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Rating = (typeof RATINGS)[number];

export const worse = (a: Rating, b: Rating): Rating => (RATINGS.indexOf(a) >= RATINGS.indexOf(b) ? a : b);

export interface Finding {
	/** A stable rule id, such as `hidden-characters`. */
	rule: string;
	rating: Rating;
	/** One plain sentence the report shows. */
	text: string;
}

/** One file of an item, read once: the same bytes are hashed and scanned. */
export interface ItemFile {
	/** Relative to the item's folder, or the file name. */
	name: string;
	/** What the scanner reads; empty for a binary file. */
	text: string;
	/** The file's bytes when they are not the text (a binary file): what is hashed instead. */
	bytes?: Uint8Array;
}

/** Something the guard reviews, built by the loader that would load it. */
export interface ReviewItem {
	kind: ReviewKind;
	/** The id the user types and `/harness` shows: `mcp:<name>`, `skill:<path>`, `hook:<digest>`. */
	id: string;
	/** Stable while the item keeps its place, whatever its content: what a stored decision is found by. */
	identity: string;
	/** `global`, or the repository root for an item inside the repository. */
	scope: string;
	label: string;
	/** Where it is defined, for display. */
	path: string;
	/** What the item can do, in plain words, most important first; the first line sets the rating floor. */
	grants: string[];
	/** The rating its capability alone gives it, before any finding. */
	floor: Rating;
	files: ItemFile[];
	/** Findings its builder made from structure the text scan cannot see (a secret-named variable, a bundled name). */
	preset?: Finding[];
	/** Set when the item could not be read in full: it is reported and cannot be approved. */
	unreadable?: string;
}

/** The three states a reviewed item can be in; an item that is not approved does not load. */
export type ReviewWord = "not checked" | "approved" | "denied";

export interface Review {
	item: ReviewItem;
	hash: string;
	rating: Rating;
	findings: Finding[];
	word: ReviewWord;
	/** The stored decision was about other content: the item changed since. */
	changed: boolean;
	/** The stored row, when one exists. */
	rowId?: number;
}

/** The badge every surface prints: `approved`, `denied`, `not checked HIGH`, `not checked · changed HIGH`. */
export function badge(review: Pick<Review, "word" | "changed" | "rating">): string {
	if (review.word === "approved") return "approved";
	const word = review.changed ? `${review.word} · changed` : review.word;
	return `${word} ${review.rating}`;
}
