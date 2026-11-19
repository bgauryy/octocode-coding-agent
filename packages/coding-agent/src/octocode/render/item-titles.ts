import {
	TITLE_CAP,
	withItemTitles,
	withItemTitlesIn,
	withItemTitlesInMarkdown,
	type ItemTitleStyle,
} from "@octocodeai/octocode-common/item-titles";

export { TITLE_CAP, withItemTitles, withItemTitlesIn, withItemTitlesInMarkdown, type ItemTitleStyle };

let titles: ReadonlyMap<string, string> = new Map();

/** Replaces the cached titles (`B12` → title) of this workspace's backlog; the backlog owner calls it when the board changes. */
export function setItemTitles(next: ReadonlyMap<string, string>): void {
	titles = next;
}

/** The cached title of `ref`, synchronously and without any read: undefined for an unknown item. */
export function itemTitle(ref: string): string | undefined {
	return titles.get(ref);
}
