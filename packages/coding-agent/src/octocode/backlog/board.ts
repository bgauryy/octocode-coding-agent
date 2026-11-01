import { truncateToWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui";
import type { BacklogTask, TaskState } from "@octocodeai/octocode-contracts/backlogs";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import type { ExtensionContext } from "../../core/extensions/index.ts";
import { shortcutText } from "../shared/keys.ts";
import { type BoardData, type BoardRow, boardLayout, epicItems } from "./board-model.ts";
import { BOARD_ORDER } from "./format.ts";
import { refText } from "./row.ts";
import { type Item, priorityName } from "./store.ts";
import { taskLine } from "./task-format.ts";
import type { State } from "@octocodeai/octocode-contracts/snapshot";

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
}

/** The order ←/→ step a task through; `dropped` is chosen from the task's actions. */
const TASK_FLOW: readonly TaskState[] = ["todo", "ongoing", "done"];

/**
 * The board: epics, then a section per state (backlog, todo, ongoing, done, top to bottom) with counts and open-task counts,
 * then this session's tasks. ↑↓ select an epic, an item or a task (the selected item shows its tasks, the selected epic its
 * items), ←→ move the selected item or task to the neighbouring state, Enter item or task actions, `a` add, `d` do it now,
 * `e` export, `h` open as HTML, Esc close. Everything is read when the board opens and after a change, never per frame.
 */
export function showBoard(
	ctx: ExtensionContext,
	source: BoardSource,
	selectRef?: string,
): Promise<BoardChoice | undefined> {
	return ctx.ui.custom<BoardChoice | undefined>((tui, theme, keybindings, done) => {
		const read = (): BoardData => ({
			items: source.load(),
			tasks: source.tasks?.load() ?? [],
			session: source.self,
		});
		let data = read();
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
			layout = boardLayout(data, selected);
			if (at() < 0) select(layout.rows[Math.min(Math.max(0, index), layout.rows.length - 1)]?.key);
		};
		const step = (by: number) => {
			const { rows } = layout;
			if (rows.length > 0) select(rows[(Math.max(0, at()) + by + rows.length) % rows.length]?.key);
		};

		function handleInput(input: string): void {
			const current = layout.rows[at()];
			flash = undefined;
			if (keybindings.matches(input, "tui.select.cancel") || keybindings.matches(input, "app.backlog.close")) {
				done(undefined);
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
					done({ action: current.kind === "task" ? "task" : "open", ref: current.key });
					return;
				}
			} else if (keybindings.matches(input, "app.backlog.add")) {
				done({ action: "add" });
				return;
			} else if (keybindings.matches(input, "app.backlog.export")) {
				done({ action: "export" });
				return;
			} else if (keybindings.matches(input, "app.backlog.html")) {
				done({ action: "html" });
				return;
			} else if (keybindings.matches(input, "app.backlog.do")) {
				if (current?.kind === "item") {
					done({ action: "do", ref: current.key });
					return;
				}
			} else return;
			refresh();
		}

		/** One selectable row as text: the part that takes the selection colour, the dim rest, and the indent. */
		function rowText(row: BoardRow): { text: string; dim: string; indent: string } {
			if (row.kind === "task") return { text: taskLine(row.task, { owner: false }), dim: "", indent: "     " };
			const { item } = row;
			const tags = item.tags.length ? ` ${item.tags.map((tag) => `#${tag}`).join(" ")}` : "";
			const from = item.from === undefined ? "" : ` ←${refText(item.from)}`;
			const parent = item.parentId && item.type !== "epic" ? ` ⊂${item.parentId}` : "";
			const tasks = row.tasks > 0 ? ` · ${row.tasks} open task${row.tasks === 1 ? "" : "s"}` : "";
			const children = item.type === "epic" ? epicItems(item, data.items) : [];
			const epic =
				item.type === "epic"
					? ` · epic ${row.shown} · ${children.filter((child) => child.state === "done").length}/${children.length} done`
					: "";
			const holder =
				item.state === "ongoing" && item.assignee
					? item.assignee === source.self
						? " (you)"
						: ` (@${sanitizeTerminalText(item.assignee)})`
					: "";
			return {
				text: `${item.ref} ${priorityName(item.priority)} ${sanitizeTerminalText(item.title)}`,
				dim: `${tags}${from}${parent}${epic}${tasks}${holder}`,
				indent: "   ",
			};
		}

		function render(width: number): string[] {
			const height = tui.terminal?.rows ?? 40;
			if (cache && cacheWidth === width && cacheHeight === height) return cache;
			const w = Math.max(1, width);
			const help = `${shortcutText("tui.select.up", keybindings)}/${shortcutText("tui.select.down", keybindings)} select · ${shortcutText("app.backlog.previousState", keybindings)}/${shortcutText("app.backlog.nextState", keybindings)} move state · ${shortcutText("tui.select.confirm", keybindings)} actions · ${shortcutText("app.backlog.add", keybindings)} add · ${shortcutText("app.backlog.do", keybindings)} do it now · ${shortcutText("app.backlog.export", keybindings)} export · ${shortcutText("app.backlog.html", keybindings)} html · ${shortcutText("tui.select.cancel", keybindings)}/${shortcutText("app.backlog.close", keybindings)} close`;
			const helpLines = wrapTextWithAnsi(help, Math.max(1, w - 1)).slice(0, Math.max(1, Math.floor(height / 4)));
			const lines: string[] = [];
			const push = (text: string) => lines.push(truncateToWidth(text, w, "…"));
			const { counts } = layout;
			const open = data.tasks.length;
			const tasks = open ? `  ·  ${open} open task${open === 1 ? "" : "s"}` : "";
			push(theme.fg("accent", "─".repeat(w)));
			push(
				` ${theme.bold(sanitizeTerminalText(source.title))}  ${theme.fg("muted", `▶${counts.ongoing} ☐${counts.todo} ⧗${counts.backlog} ✓${counts.done}${tasks}`)}`,
			);
			const listed: string[] = [];
			let selectedLine = 0;
			for (const entry of layout.entries) {
				if (entry.kind === "heading") {
					listed.push("");
					listed.push(
						` ${theme.fg("accent", theme.bold(entry.title))}${entry.note ? theme.fg("dim", ` · ${entry.note}`) : ""}`,
					);
				} else if (entry.kind === "empty") listed.push(theme.fg("dim", "   (none)"));
				else if (entry.kind === "context") listed.push(theme.fg("dim", `      ${sanitizeTerminalText(entry.text)}`));
				else {
					const { text, dim, indent } = rowText(entry.row);
					if (entry.row.key === selected) {
						selectedLine = listed.length;
						listed.push(
							`${indent.slice(0, -3)}${theme.fg("accent", " › ")}${theme.fg("accent", text)}${theme.fg("dim", dim)}`,
						);
					} else listed.push(`${indent}${text}${theme.fg("dim", dim)}`);
				}
			}
			// Keep the selection on screen when the board is taller than the terminal.
			const room = Math.max(1, height - 6 - helpLines.length - (flash ? 1 : 0));
			const start =
				listed.length <= room ? 0 : Math.min(Math.max(0, selectedLine - Math.floor(room / 2)), listed.length - room);
			for (const line of listed.slice(start, start + room)) push(line);
			lines.push("");
			if (flash) push(` ${theme.fg("warning", sanitizeTerminalText(flash))}`);
			for (const line of helpLines) push(` ${theme.fg("dim", line)}`);
			push(theme.fg("accent", "─".repeat(w)));
			cache = lines;
			cacheWidth = width;
			cacheHeight = height;
			return lines;
		}

		return {
			render,
			handleInput,
			invalidate: () => {
				cache = undefined;
				return cache;
			},
		};
	});
}
