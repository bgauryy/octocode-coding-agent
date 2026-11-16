import { type RowColumn, fitRows } from "@octocodeai/octocode-tui";
import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { BoardRow } from "./board-model.ts";
import { epicItems } from "./board-model.ts";
import {
	BLOCKED_GLYPH,
	EPIC_GLYPH,
	PRIORITY_COLOR,
	STALE_GLYPH,
	STATE_COLOR,
	STATE_GLYPH,
	TASK_COLOR,
	TASK_GLYPH,
	type BoardTheme,
} from "./board-style.ts";
import { refText } from "./row.ts";
import { type Item, priorityName } from "./store.ts";

type ItemRow = Extract<BoardRow, { kind: "item" }>;
type TaskRow = Extract<BoardRow, { kind: "task" }>;

/**
 * Item rows, left to right: state, ref, priority, title (the flexible cell), what blocks or holds it, progress or open
 * tasks, who holds it, tags, where it came from. The higher the priority the longer the column stays as the line narrows.
 */
const ITEM_COLUMNS: readonly RowColumn[] = [
	{ priority: 100 },
	{ priority: 100 },
	{ priority: 90 },
	{ priority: 95, flex: true },
	{ priority: 85, max: 30 },
	{ priority: 80, max: 16 },
	{ priority: 70, max: 20 },
	{ priority: 40, max: 26 },
	{ priority: 30, max: 14 },
];

/** Task rows: state, ref, goal (flexible), result. */
const TASK_COLUMNS: readonly RowColumn[] = [
	{ priority: 100 },
	{ priority: 100 },
	{ priority: 95, flex: true },
	{ priority: 50, max: 40 },
];

/** The blockers, open-review and stale marks of an item as one warning cell; empty when there are none. */
function flag(row: ItemRow, theme: BoardTheme): string {
	const { item, marks } = row;
	const parts: string[] = [];
	if (item.state !== "done" && marks.blockedBy?.length) {
		const shown = marks.blockedBy.slice(0, 2).join(", ");
		const more = marks.blockedBy.length > 2 ? ` +${marks.blockedBy.length - 2}` : "";
		parts.push(`${BLOCKED_GLYPH} blocked by ${shown}${more}`);
	}
	if (marks.openBelow?.length) parts.push(`${STALE_GLYPH} review ${marks.openBelow.join(", ")}`);
	if (marks.stale) parts.push(`${STALE_GLYPH} stale`);
	return parts.length ? theme.fg("warning", parts.join(" ")) : "";
}

/** An epic's derived state with how many of its items are done, or the open-task count of any other item. */
function progress(row: ItemRow, items: readonly Item[], theme: BoardTheme): string {
	const { item } = row;
	if (item.type === "epic") {
		const children = epicItems(item, items);
		const done = children.filter((child) => child.state === "done").length;
		return theme.fg(
			STATE_COLOR[row.shown],
			`${row.shown} ${children.length ? `${done}/${children.length}` : "no items"}`,
		);
	}
	return row.tasks > 0 ? theme.fg("muted", `${row.tasks} task${row.tasks === 1 ? "" : "s"}`) : "";
}

function holder(item: Item, self: string, theme: BoardTheme): string {
	if (item.state !== "ongoing" || !item.assignee) return "";
	return item.assignee === self
		? theme.fg("accent", "you")
		: theme.fg("muted", `@${sanitizeTerminalText(item.assignee)}`);
}

function itemCells(row: ItemRow, items: readonly Item[], self: string, theme: BoardTheme): string[] {
	const { item } = row;
	const done = row.shown === "done";
	const glyph = item.type === "epic" ? EPIC_GLYPH : STATE_GLYPH[row.shown];
	const title = sanitizeTerminalText(item.title);
	const links = [
		item.from === undefined ? "" : `←${refText(item.from)}`,
		item.parentId && item.type !== "epic" ? `⊂${item.parentId}` : "",
	]
		.filter(Boolean)
		.join(" ");
	return [
		theme.fg(STATE_COLOR[row.shown], glyph),
		theme.fg(done ? "dim" : "text", item.ref),
		theme.fg(PRIORITY_COLOR[item.priority] ?? "text", priorityName(item.priority)),
		done ? theme.fg("dim", title) : title,
		flag(row, theme),
		progress(row, items, theme),
		holder(item, self, theme),
		item.tags.length ? theme.fg("dim", item.tags.map((tag) => `#${sanitizeTerminalText(tag)}`).join(" ")) : "",
		links ? theme.fg("dim", links) : "",
	];
}

function taskCells(task: BacklogTask, theme: BoardTheme): string[] {
	const done = task.state === "done" || task.state === "dropped";
	const goal = sanitizeTerminalText(task.goal);
	return [
		theme.fg(TASK_COLOR[task.state], TASK_GLYPH[task.state]),
		theme.fg("dim", task.ref),
		done ? theme.fg("dim", goal) : goal,
		task.result ? theme.fg("dim", `\u2014 ${sanitizeTerminalText(task.result)}`) : "",
	];
}

/**
 * Every item row of the board fitted to `width` columns, by key, so their columns line up from the Epics down to the last
 * section. The caller indents the rows and marks the selected one.
 */
export function itemRowLines(
	rows: readonly ItemRow[],
	items: readonly Item[],
	self: string,
	theme: BoardTheme,
	width: number,
): Map<string, string> {
	const { lines } = fitRows(
		rows.map((row) => itemCells(row, items, self, theme)),
		ITEM_COLUMNS,
		width,
		// The title keeps about a third of the line before a lower-priority column drops, so a wide terminal does not
		// spend its room on tags and links while the title is cut; a narrow one keeps blockers and progress instead.
		{ minFlex: Math.min(40, Math.max(12, Math.round(width * 0.35))) },
	);
	return new Map(rows.map((row, index) => [row.key, lines[index]]));
}

/** The task rows of the board fitted to `width` columns, by key. */
export function taskRowLines(rows: readonly TaskRow[], theme: BoardTheme, width: number): Map<string, string> {
	const { lines } = fitRows(
		rows.map((row) => taskCells(row.task, theme)),
		TASK_COLUMNS,
		width,
	);
	return new Map(rows.map((row, index) => [row.key, lines[index]]));
}
