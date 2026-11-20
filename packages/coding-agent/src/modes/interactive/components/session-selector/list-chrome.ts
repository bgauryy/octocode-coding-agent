import { truncateToWidth } from "@octocodeai/octocode-tui";
import { theme } from "../../../../theme/theme.ts";
import { noMatchMessage, keyText } from "../../../../theme/theme-tui-helpers.ts";
import { searchQueryError, type NameFilter } from "../session-selector-search.ts";
import type { GroupMode } from "./groups.ts";
import { folderColumn } from "./utils.ts";

/**
 * What the list says when nothing is shown, with the one key that recovers. A search names its query and leaves the
 * recovery to the list, which says `esc clears`.
 */
export function emptyFor(
	nameFilter: NameFilter,
	allFolders: boolean,
	query: string,
): { message: string; recover?: readonly [key: string, verb: string] } {
	const what = nameFilter === "named" ? "named sessions" : "sessions";
	if (query.trim()) {
		const error = searchQueryError(query);
		return { message: error ? `Invalid search: ${error}` : noMatchMessage(what, query) };
	}
	if (nameFilter === "named")
		return {
			message: `No named sessions${allFolders ? "" : " in this folder"}`,
			recover: [keyText("app.session.toggleNamedFilter"), "shows all"],
		};
	return allFolders
		? { message: "No sessions found" }
		: { message: "No sessions in this folder", recover: [keyText("tui.input.tab"), "views all folders"] };
}

/** A group label line: a day bucket, or a folder (`key` is its path) with its checkout. */
export function renderGroupLabel(
	key: string,
	mode: GroupMode,
	checkout: (folder: string) => string | undefined,
	width: number,
): string {
	let text = key;
	if (mode === "folder") text = key ? folderColumn(key, checkout(key), Math.max(10, width - 2)) : "(unknown folder)";
	return theme.fg("muted", theme.bold(` ${truncateToWidth(text, Math.max(1, width - 1), "…")}`));
}
