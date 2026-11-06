import { type RowColumn, fitRows } from "@octocodeai/octocode-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { shortcutText } from "../shared/keys.ts";
import { type BoardTheme, EPIC_GLYPH, STATE_COLOR, STATE_GLYPH } from "./board-style.ts";
import { type BacklogCounts, openEpics } from "./counts.ts";

/**
 * The board's header: the title (cut first) and the counts. The counts are the footer's (`BacklogCounts`), spelled out
 * (`▶ 2 ongoing`) while they fit and as bare glyphs and numbers (`▶2`) when they do not, so the glyphs always have
 * a legend nearby.
 */
export function headerLine(
	title: string,
	counts: BacklogCounts,
	openTasks: number,
	theme: BoardTheme,
	width: number,
): string {
	const { items } = counts;
	const epics = openEpics(counts);
	const columns: RowColumn[] = [
		{ priority: 100, flex: true },
		{ priority: 90 },
		{ priority: 85 },
		{ priority: 80 },
		{ priority: 60 },
		{ priority: 50 },
		{ priority: 70 },
		{ priority: 40 },
	];
	const cells = (long: boolean): string[] => [
		theme.bold(sanitizeTerminalText(title)),
		...(["ongoing", "todo", "backlog", "done"] as const).map((state) =>
			theme.fg(
				items[state] ? STATE_COLOR[state] : "dim",
				`${STATE_GLYPH[state]}${long ? " " : ""}${items[state]}${long ? ` ${state}` : ""}`,
			),
		),
		epics
			? theme.fg("muted", `${EPIC_GLYPH}${long ? " " : ""}${epics}${long ? ` epic${epics === 1 ? "" : "s"}` : ""}`)
			: "",
		openTasks ? theme.fg("muted", `${openTasks}${long ? ` open task${openTasks === 1 ? "" : "s"}` : " tasks"}`) : "",
		counts.closed ? theme.fg("dim", `${counts.closed}${long ? " closed" : "✕"}`) : "",
	];
	// A column that holds no text is never kept, so a dropped column of the spelled-out form is a real loss.
	const wanted = cells(true).filter(Boolean).length;
	const long = fitRows([cells(true)], columns, width, { gap: "  " });
	const kept = long.kept.filter(Boolean).length;
	const fitted = kept === wanted ? long : fitRows([cells(false)], columns, width, { gap: "  " });
	return ` ${fitted.lines[0]}`;
}

/** The keys the board answers to, most important first: `[text, priority]`. */
function helpEntries(keys: KeybindingsManager): Array<[string, string, number]> {
	const key = (action: Parameters<typeof shortcutText>[0]) => shortcutText(action, keys);
	return [
		[`${key("tui.select.cancel")}/${key("app.backlog.close")}`, "close", 100],
		[`${key("tui.select.up")}/${key("tui.select.down")}`, "select", 95],
		[key("tui.select.confirm"), "actions", 90],
		[`${key("app.backlog.previousState")}/${key("app.backlog.nextState")}`, "move state", 85],
		[key("app.backlog.add"), "add", 60],
		[key("app.backlog.do"), "do it now", 55],
		[key("app.backlog.export"), "export", 40],
		[key("app.backlog.html"), "html", 35],
	];
}

/** The key help as one line of `key label` pairs that never wraps: the lowest-priority pairs drop as the line narrows. */
export function helpLine(keys: KeybindingsManager, theme: BoardTheme, width: number): string {
	const entries = helpEntries(keys);
	// The close key reads last, as before, but is the last to go.
	const order = [...entries.slice(1), entries[0]];
	const columns = order.map(([, , priority]): RowColumn => ({ priority }));
	const cells = order.map(([key, label]) => `${theme.fg("muted", key)} ${theme.fg("dim", label)}`);
	return ` ${fitRows([cells], columns, Math.max(1, width - 1), { gap: theme.fg("dim", " · ") }).lines[0]}`;
}
