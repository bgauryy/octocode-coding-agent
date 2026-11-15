import { truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { BacklogTask, TaskState } from "@octocodeai/octocode-contracts/backlogs";
import type { State } from "@octocodeai/octocode-contracts/snapshot";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import type { ExtensionContext } from "../../core/features/index.ts";
import { ruleLine } from "../../theme/dynamic-border.ts";
import { onSecond } from "../shared/clock.ts";
import { headerLine, helpLine } from "./board-chrome.ts";
import { type BoardData, type BoardRow, boardLayout } from "./board-model.ts";
import { itemRowLines, taskRowLines } from "./board-rows.ts";
import { CURSOR, STATE_COLOR, STATE_GLYPH } from "./board-style.ts";
import { BOARD_ORDER } from "./format.ts";
import type { ItemMarks } from "./marks.ts";
import type { Item } from "./store.ts";

/** What the user picked on the board; the command runs it and reopens the board unless it handed work to the agent. */
type BoardChoice =
	| { action: "open" | "do"; ref: string }
	| { action: "task"; ref: string }
	| { action: "add" }
	| { action: "export" }
	| { action: "html" };

interface BoardSource {
	title: string;
	/** Fresh items (all states), re-read after every change. */
	load(): Item[];
	/** Move an item one column; returns a refusal to show, or undefined. */
	move(item: Item, state: State): string | undefined;
	/** Who "you" is, to mark items this session holds. */
	self: string;
	/** The repository's open tasks (re-read with the items) and a task's move to a neighbouring state; without it the board shows no tasks. */
	tasks?: { load(): BacklogTask[]; move(task: BacklogTask, state: TaskState): string | undefined };
	/** What blocks or holds each of `items` (`BacklogStore.marks`); without it rows show no marks. */
	marks?(items: Item[]): ReadonlyMap<string, ItemMarks>;
	/** Changes whenever any process writes the database (`BacklogStore.revision`); the open board re-reads when it moves. */
	revision?(): string;
	/** Called after the open board re-read because another process wrote, so what else shows the backlog (the footer counts) can follow. */
	changed?(): void;
}

/** The order ←/→ step a task through; `dropped` is chosen from the task's actions. */
const TASK_FLOW: readonly TaskState[] = ["todo", "ongoing", "done"];

/**
 * The board: epics, then a section per state (backlog, todo, ongoing, done, top to bottom) with counts and open-task counts,
 * then this session's tasks. ↑↓ select an epic, an item or a task (the selected item shows its tasks, the selected epic its
 * items), ←→ move the selected item or task to the neighbouring state, Enter item or task actions, `a` add, `d` do it now,
 * `e` export, `h` open as HTML, Esc close. Rows are columns that fit the width (`board-rows.ts`). Everything is read when
 * the board opens and after a change, never per frame; while it is open a once-a-second check of the database revision
 * re-reads it when another process wrote (the check stops when the board closes or is disposed).
 */
export function showBoard(
	ctx: ExtensionContext,
	source: BoardSource,
	selectRef?: string,
): Promise<BoardChoice | undefined> {
	return ctx.ui.custom<BoardChoice | undefined>((tui, theme, keybindings, done) => {
		const read = (): BoardData => {
			const items = source.load();
			return { items, tasks: source.tasks?.load() ?? [], session: source.self, marks: source.marks?.(items) };
		};
		let data = read();
		let seen = source.revision?.();
		let selected = selectRef;
		let layout = boardLayout(data, selected);
		if (!layout.rows.some((row) => row.key === selected)) selected = layout.rows[0]?.key;
		layout = boardLayout(data, selected);
		let flash: string | undefined;
		let cache: string[] | undefined;
		let cacheWidth = 0;
		let cacheHeight = 0;
		const refresh = () => {
			cache = undefined;
			tui.requestRender();
		};
		const select = (key: string | undefined) => {
			selected = key;
			layout = boardLayout(data, selected);
		};
		const at = () => layout.rows.findIndex((row) => row.key === selected);
		/** Re-read, keeping the selection by key; a row that vanished (a finished task) leaves the cursor at the same place. */
		const reload = () => {
			const index = at();
			data = read();
			seen = source.revision?.();
			layout = boardLayout(data, selected);
			if (at() < 0) select(layout.rows[Math.min(Math.max(0, index), layout.rows.length - 1)]?.key);
		};
		const step = (by: number) => {
			const { rows } = layout;
			if (rows.length > 0) select(rows[(Math.max(0, at()) + by + rows.length) % rows.length]?.key);
		};

		// Another session, subagent or process may write while the board is open: compare the revision and re-read on a change.
		let stopWatching: (() => void) | undefined = source.revision
			? onSecond(() => {
					try {
						if (source.revision?.() === seen) return;
						reload();
						refresh();
						source.changed?.();
					} catch {
						// An unreadable database keeps the last frame; the next tick tries again.
					}
				})
			: undefined;
		const stop = () => {
			stopWatching?.();
			stopWatching = undefined;
		};
		const finish = (choice: BoardChoice | undefined) => {
			stop();
			done(choice);
		};

		function handleInput(input: string): void {
			const current = layout.rows[at()];
			flash = undefined;
			if (keybindings.matches(input, "tui.select.cancel") || keybindings.matches(input, "app.backlog.close")) {
				finish(undefined);
				return;
			}
			if (keybindings.matches(input, "tui.select.up")) step(-1);
			else if (keybindings.matches(input, "tui.select.down")) step(1);
			else if (
				keybindings.matches(input, "app.backlog.previousState") ||
				keybindings.matches(input, "app.backlog.nextState")
			) {
				if (!current) return;
				const forward = keybindings.matches(input, "app.backlog.nextState");
				if (current.kind === "task") {
					// → steps toward done, ← back toward todo; a dropped task steps like a todo one.
					const next = TASK_FLOW[Math.max(0, TASK_FLOW.indexOf(current.task.state)) + (forward ? 1 : -1)];
					if (!next || !source.tasks) return;
					flash = source.tasks.move(current.task, next);
				} else if (current.item.type === "epic") {
					// The row shows the state its items give it; stepping the stored one would move it the wrong way.
					flash = `${current.item.ref} is an epic: its state follows its items.`;
				} else {
					// → steps toward done, ← back toward backlog: the same order the sections are drawn in.
					const next = BOARD_ORDER[BOARD_ORDER.indexOf(current.item.state) + (forward ? 1 : -1)];
					if (!next) return;
					flash = source.move(current.item, next);
				}
				reload();
			} else if (keybindings.matches(input, "tui.select.confirm")) {
				if (current) {
					finish({ action: current.kind === "task" ? "task" : "open", ref: current.key });
					return;
				}
			} else if (keybindings.matches(input, "app.backlog.add")) {
				finish({ action: "add" });
				return;
			} else if (keybindings.matches(input, "app.backlog.export")) {
				finish({ action: "export" });
				return;
			} else if (keybindings.matches(input, "app.backlog.html")) {
				finish({ action: "html" });
				return;
			} else if (keybindings.matches(input, "app.backlog.do")) {
				if (current?.kind === "item") {
					finish({ action: "do", ref: current.key });
					return;
				}
			} else return;
			refresh();
		}

		function render(width: number): string[] {
			const height = tui.terminal?.rows ?? 40;
			if (cache && cacheWidth === width && cacheHeight === height) return cache;
			const w = Math.max(1, width);
			const lines: string[] = [];
			const push = (text: string) => lines.push(truncateToWidth(text, w, "…"));
			push(ruleLine(w, (text) => theme.fg("border", text)));
			push(headerLine(source.title, layout.counts, data.tasks.length, theme, w));

			// Item rows share one grid so their columns line up across the sections; tasks hang two cells deeper in their own.
			const itemRows = layout.rows.filter((row): row is Extract<BoardRow, { kind: "item" }> => row.kind === "item");
			const taskRows = layout.rows.filter((row): row is Extract<BoardRow, { kind: "task" }> => row.kind === "task");
			const itemText = itemRowLines(itemRows, data.items, source.self, theme, Math.max(1, w - 3));
			const taskText = taskRowLines(taskRows, theme, Math.max(1, w - 5));
			const cursor = theme.bold(theme.fg("accent", ` ${CURSOR} `));
			const glyph = (state: State | undefined) => (state ? `${theme.fg(STATE_COLOR[state], STATE_GLYPH[state])} ` : "");
			const listed: string[] = [];
			let selectedLine = 0;
			for (const entry of layout.entries) {
				if (entry.kind === "heading") {
					listed.push("");
					const note = entry.note ? theme.fg("dim", ` · ${entry.note}`) : "";
					listed.push(` ${glyph(entry.state)}${theme.fg("accent", theme.bold(entry.title))}${note}`);
				} else if (entry.kind === "empty") listed.push(theme.fg("dim", "   (none)"));
				else if (entry.kind === "context")
					listed.push(`      ${glyph(entry.state)}${theme.fg("dim", sanitizeTerminalText(entry.text))}`);
				else {
					const { row } = entry;
					const text = (row.kind === "item" ? itemText : taskText).get(row.key) ?? "";
					const indent = row.kind === "item" ? "" : "  ";
					if (row.key !== selected) listed.push(`   ${indent}${text}`);
					else {
						selectedLine = listed.length;
						const line = truncateToWidth(`${cursor}${indent}${text}`, w, "…");
						listed.push(theme.bg("selectedBg", `${line}${" ".repeat(Math.max(0, w - visibleWidth(line)))}`));
					}
				}
			}
			// Keep the selection on screen when the board is taller than the terminal.
			const room = Math.max(1, height - 7 - (flash ? 1 : 0));
			const start =
				listed.length <= room ? 0 : Math.min(Math.max(0, selectedLine - Math.floor(room / 2)), listed.length - room);
			for (const line of listed.slice(start, start + room)) push(line);
			lines.push("");
			if (flash) push(` ${theme.fg("warning", sanitizeTerminalText(flash))}`);
			push(helpLine(keybindings, theme, w));
			push(ruleLine(w, (text) => theme.fg("border", text)));
			cache = lines;
			cacheWidth = width;
			cacheHeight = height;
			return lines;
		}

		return {
			render,
			handleInput,
			dispose: stop,
			invalidate: () => {
				cache = undefined;
				return cache;
			},
		};
	});
}
