import { truncateToWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui";
import type { ExtensionContext } from "../../core/extensions/index.ts";
import { shortcutText } from "../shared/keys.ts";
import { sanitizeTerminalText } from "../shared/sanitize.ts";
import { STATE_TITLE, BOARD_ORDER } from "./format.ts";
import { refText } from "./row.ts";
import { type Item, priorityName } from "./store.ts";
import type { State } from "@octocodeai/octocode-contracts/snapshot";

/** What the user picked on the board; the command runs it and reopens the board unless it handed work to the agent. */
type BoardChoice =
	| { action: "open" | "do"; ref: string }
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
}

const DONE_SHOWN = 5;

/** Items in board order: grouped by state, Done cut to the most recent few. */
export function boardRows(items: Item[]): Item[] {
	return BOARD_ORDER.flatMap((state) => {
		const group = items.filter((item) => item.state === state);
		return state === "done"
			? group.sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt)).slice(0, DONE_SHOWN)
			: group;
	});
}

/**
 * The board: a section per state (backlog, todo, ongoing, done, top to bottom) with counts, ↑↓ select, ←→ move the
 * selected item to the section above/below,
 * Enter item actions, `a` add, `d` do it now, `e` export, `h` open as HTML, Esc close.
 */
export function showBoard(
	ctx: ExtensionContext,
	source: BoardSource,
	selectRef?: string,
): Promise<BoardChoice | undefined> {
	return ctx.ui.custom<BoardChoice | undefined>((tui, theme, keybindings, done) => {
		let items = source.load();
		let rows = boardRows(items);
		let cursor = Math.max(
			0,
			rows.findIndex((item) => item.ref === selectRef),
		);
		let flash: string | undefined;
		let cache: string[] | undefined;
		let cacheWidth = 0;
		let cacheHeight = 0;
		const refresh = () => {
			cache = undefined;
			tui.requestRender();
		};
		const reload = (ref?: string) => {
			items = source.load();
			rows = boardRows(items);
			const at = ref ? rows.findIndex((item) => item.ref === ref) : -1;
			cursor = at >= 0 ? at : Math.min(cursor, Math.max(0, rows.length - 1));
		};

		function handleInput(data: string): void {
			const current = rows[cursor];
			flash = undefined;
			if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.backlog.close")) {
				done(undefined);
				return;
			}
			if (keybindings.matches(data, "tui.select.up"))
				cursor = rows.length ? (cursor + rows.length - 1) % rows.length : 0;
			else if (keybindings.matches(data, "tui.select.down")) cursor = rows.length ? (cursor + 1) % rows.length : 0;
			else if (
				keybindings.matches(data, "app.backlog.previousState") ||
				keybindings.matches(data, "app.backlog.nextState")
			) {
				if (!current) return;
				// → steps toward done, ← back toward backlog: the same order the sections are drawn in.
				const next =
					BOARD_ORDER[
						BOARD_ORDER.indexOf(current.state) + (keybindings.matches(data, "app.backlog.nextState") ? 1 : -1)
					];
				if (!next) return;
				flash = source.move(current, next);
				reload(current.ref);
			} else if (keybindings.matches(data, "tui.select.confirm")) {
				if (current) {
					done({ action: "open", ref: current.ref });
					return;
				}
			} else if (keybindings.matches(data, "app.backlog.add")) {
				done({ action: "add" });
				return;
			} else if (keybindings.matches(data, "app.backlog.export")) {
				done({ action: "export" });
				return;
			} else if (keybindings.matches(data, "app.backlog.html")) {
				done({ action: "html" });
				return;
			} else if (keybindings.matches(data, "app.backlog.do")) {
				if (current) {
					done({ action: "do", ref: current.ref });
					return;
				}
			} else return;
			refresh();
		}

		function render(width: number): string[] {
			const height = tui.terminal?.rows ?? 40;
			if (cache && cacheWidth === width && cacheHeight === height) return cache;
			const w = Math.max(1, width);
			const help = `${shortcutText("tui.select.up", keybindings)}/${shortcutText("tui.select.down", keybindings)} select · ${shortcutText("app.backlog.previousState", keybindings)}/${shortcutText("app.backlog.nextState", keybindings)} move state · ${shortcutText("tui.select.confirm", keybindings)} actions · ${shortcutText("app.backlog.add", keybindings)} add · ${shortcutText("app.backlog.do", keybindings)} do it now · ${shortcutText("app.backlog.export", keybindings)} export · ${shortcutText("app.backlog.html", keybindings)} html · ${shortcutText("tui.select.cancel", keybindings)}/${shortcutText("app.backlog.close", keybindings)} close`;
			const helpLines = wrapTextWithAnsi(help, Math.max(1, w - 1)).slice(0, Math.max(1, Math.floor(height / 4)));
			const lines: string[] = [];
			const push = (text: string) => lines.push(truncateToWidth(text, w, "…"));
			const count = (state: State) => items.filter((item) => item.state === state).length;
			push(theme.fg("accent", "─".repeat(w)));
			push(
				` ${theme.bold(sanitizeTerminalText(source.title))}  ${theme.fg("muted", `▶${count("ongoing")} ☐${count("todo")} ⧗${count("backlog")} ✓${count("done")}`)}`,
			);
			const listed: string[] = [];
			let selectedLine = 0;
			for (const state of BOARD_ORDER) {
				const group = rows.filter((item) => item.state === state);
				const total = count(state);
				listed.push("");
				listed.push(
					` ${theme.fg("accent", theme.bold(`${STATE_TITLE[state]} (${total})`))}${state === "done" && total > group.length ? theme.fg("dim", ` · latest ${group.length}`) : ""}`,
				);
				if (group.length === 0) listed.push(theme.fg("dim", "   (none)"));
				for (const item of group) {
					const selected = rows[cursor] === item;
					if (selected) selectedLine = listed.length;
					const owner =
						item.state === "ongoing" && item.assignee
							? item.assignee === source.self
								? " (you)"
								: ` (@${sanitizeTerminalText(item.assignee)})`
							: "";
					const tags = item.tags.length ? ` ${item.tags.map((tag) => `#${tag}`).join(" ")}` : "";
					const from = item.from === undefined ? "" : ` ←${refText(item.from)}`;
					const text = `${item.ref} ${priorityName(item.priority)} ${sanitizeTerminalText(item.title)}${theme.fg("dim", `${tags}${from}${owner}`)}`;
					listed.push(selected ? `${theme.fg("accent", " › ")}${theme.fg("accent", text)}` : `   ${text}`);
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
