import { withItemTitlesInMarkdown } from "@octocodeai/octocode-common/item-titles";
import { useMemo } from "react";
import { useStore } from "zustand";
import { useLive } from "./session.tsx";

/**
 * Draws known backlog IDs in assistant text as `B12 “Title”` at their first mention, from the titles of the board the page
 * already holds; code and a title the writer typed stay as written. Returns the text unchanged when no ID is known.
 */
export function useItemTitles(): (markdown: string) => string {
	const { backlog } = useLive();
	const items = useStore(backlog, (state) => state.snapshot.items);
	return useMemo(() => {
		const titles = new Map(items.map((item) => [item.ref, item.title]));
		return (markdown) => withItemTitlesInMarkdown(markdown, (ref) => titles.get(ref));
	}, [items]);
}
