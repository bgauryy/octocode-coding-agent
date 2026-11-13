import { type Input, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import { theme } from "../../../../theme/theme.ts";
import { keyText } from "../../../../theme/theme-tui-helpers.ts";
import type { NameFilter } from "../session-selector-search.ts";
import type { GroupMode } from "./groups.ts";
import { folderColumn } from "./utils.ts";

/** The search box: `input` inside a rounded border, three lines. */
export function renderSearchBox(input: Input, width: number): string[] {
	const inner = Math.max(1, width - 4);
	const border = (text: string) => theme.fg("border", text);
	const field = truncateToWidth(input.render(inner)[0] ?? "", inner, "");
	const pad = " ".repeat(Math.max(0, inner - visibleWidth(field)));
	return [
		border(`╭${"─".repeat(inner + 2)}╮`),
		`${border("│")} ${field}${pad} ${border("│")}`,
		border(`╰${"─".repeat(inner + 2)}╯`),
	].map((line) => truncateToWidth(line, width, ""));
}

/** What the list says when nothing is shown. */
export function emptyMessage(nameFilter: NameFilter, allFolders: boolean, query = ""): string {
	if (query.trim()) {
		const what = nameFilter === "named" ? "named sessions" : "sessions";
		return `  No ${what} match this search. Edit or clear the search.`;
	}
	if (nameFilter === "named") {
		const toggleKey = keyText("app.session.toggleNamedFilter");
		return allFolders
			? `  No named sessions found. Press ${toggleKey} to show all.`
			: `  No named sessions in current folder. Press ${toggleKey} to show all, or Tab to view all.`;
	}
	if (allFolders) return "  No sessions found";
	return "  No sessions in current folder. Press Tab to view all.";
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
