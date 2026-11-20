import assert from "node:assert";
import { describe, it } from "node:test";
import { ListView, type ListViewOptions } from "../src/components/list-view.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { visibleWidth } from "../src/utils/width.ts";

const plain = (text: string) => text;
const theme = { cursor: plain, position: plain, empty: plain };
const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	home: "\x1b[H",
	end: "\x1b[F",
	enter: "\r",
	esc: "\x1b",
};
const names = (count: number) => Array.from({ length: count }, (_, i) => `item ${i + 1}`);

function list(count: number, options: Partial<ListViewOptions<string>> = {}) {
	const view = new ListView<string>({ items: names(count), row: (item) => item, maxRows: 5, theme, ...options });
	const events: string[] = [];
	view.onSelect = (item) => events.push(`select ${item}`);
	view.onCancel = () => events.push("cancel");
	return { view, events, lines: (width = 40) => view.render(width).map((line) => stripTerminalSequences(line)) };
}

const mouse = (type: TuiMouseEvent["type"], y: number, wheelDelta?: number): TuiMouseEvent =>
	({
		type,
		button: type === "wheel" ? "none" : "left",
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width: 40,
		height: 6,
		wheelDelta,
	}) as TuiMouseEvent;

describe("ListView", () => {
	it("marks the selected row with › and the others with two spaces", () => {
		const { lines } = list(3);
		assert.deepStrictEqual(lines(), ["› item 1", "  item 2", "  item 3"]);
	});

	it("clamps up and down at the ends instead of wrapping", () => {
		const { view } = list(3);
		view.handleInput(KEYS.up);
		assert.strictEqual(view.getSelectedIndex(), 0);
		for (let i = 0; i < 5; i++) view.handleInput(KEYS.down);
		assert.strictEqual(view.getSelectedIndex(), 2);
	});

	it("moves one page by the visible rows and stops at the ends", () => {
		const { view } = list(12);
		view.handleInput(KEYS.pageDown);
		assert.strictEqual(view.getSelectedIndex(), 5);
		view.handleInput(KEYS.pageDown);
		view.handleInput(KEYS.pageDown);
		assert.strictEqual(view.getSelectedIndex(), 11);
		view.handleInput(KEYS.pageUp);
		assert.strictEqual(view.getSelectedIndex(), 6);
		view.handleInput(KEYS.pageUp);
		view.handleInput(KEYS.pageUp);
		assert.strictEqual(view.getSelectedIndex(), 0);
	});

	it("shows an a–b/total foot counting items, only when the list scrolls", () => {
		assert.ok(
			!list(5)
				.lines()
				.some((line) => line.includes("/5")),
		);
		const { view, lines } = list(30);
		assert.strictEqual(lines().at(-1)?.trim(), "1–5/30");
		for (let i = 0; i < 6; i++) view.handleInput(KEYS.down);
		assert.strictEqual(lines().at(-1)?.trim(), "4–8/30", "one row of context below the cursor");
		view.handleInput(KEYS.pageDown);
		view.handleInput(KEYS.pageDown);
		view.handleInput(KEYS.pageDown);
		view.handleInput(KEYS.pageDown);
		view.handleInput(KEYS.pageDown);
		assert.strictEqual(lines().at(-1)?.trim(), "26–30/30");
	});

	it("moves one row per wheel step, clamped, and ignores the wheel when empty", () => {
		const { view } = list(3);
		view.handleMouse(mouse("wheel", 0, 1));
		assert.strictEqual(view.getSelectedIndex(), 1);
		for (let i = 0; i < 4; i++) view.handleMouse(mouse("wheel", 0, 1));
		assert.strictEqual(view.getSelectedIndex(), 2);
		view.handleMouse(mouse("wheel", 0, -1));
		assert.strictEqual(view.getSelectedIndex(), 1);
		assert.strictEqual(list(0).view.handleMouse(mouse("wheel", 0, 1)), undefined);
	});

	it("selects on the first click and confirms on a click on the selected row", () => {
		const { view, events, lines } = list(5);
		lines();
		view.handleMouse(mouse("press", 2));
		view.handleMouse(mouse("click", 2));
		assert.strictEqual(view.getSelectedIndex(), 2);
		assert.deepStrictEqual(events, []);
		view.handleMouse(mouse("press", 2));
		view.handleMouse(mouse("click", 2));
		assert.deepStrictEqual(events, ["select item 3"]);
	});

	it("only selects on clicks when clickConfirms is off", () => {
		const { view, events, lines } = list(5, { clickConfirms: false });
		lines();
		for (let i = 0; i < 2; i++) {
			view.handleMouse(mouse("press", 1));
			view.handleMouse(mouse("click", 1));
		}
		assert.strictEqual(view.getSelectedIndex(), 1);
		assert.deepStrictEqual(events, []);
	});

	it("shows one empty-state row naming its recovery key, and a hint line that never wraps", () => {
		const empty = list(0, { empty: { message: "No sessions", recover: ["n", "new"] }, emptyHint: "esc close" });
		assert.deepStrictEqual(empty.lines(), ["  No sessions · n new", " esc close"]);
		const hinted = list(30, { hint: "↑↓ move · enter select · esc close · tab switch · ctrl+o expand" });
		for (const width of [20, 30, 40]) {
			const lines = hinted.view.render(width);
			assert.strictEqual(lines.length, 6, "five rows and one foot line");
			assert.ok(visibleWidth(lines.at(-1) ?? "") <= width, `${width}: the foot fits`);
		}
	});

	it("filters with a ⌕ search line; esc clears the search first, then cancels", () => {
		const items = ["alpha", "beta", "gamma"];
		const view = new ListView<string>({ items, row: (i) => i, maxRows: 5, theme, search: { text: (i) => i } });
		const events: string[] = [];
		view.onCancel = () => events.push("cancel");
		view.handleInput("g");
		view.handleInput("a");
		const lines = view.render(40).map((line) => stripTerminalSequences(line));
		assert.strictEqual(lines[0], " ⌕ ga");
		assert.deepStrictEqual(lines.slice(1), ["› gamma"]);
		view.handleInput("z");
		assert.deepStrictEqual(
			view.render(40).map((line) => stripTerminalSequences(line)),
			[" ⌕ gaz", "  No items · esc clears"],
		);
		view.handleInput(KEYS.esc);
		assert.strictEqual(view.getQuery(), "");
		assert.deepStrictEqual(events, []);
		assert.strictEqual(view.getItems().length, 3);
		view.handleInput(KEYS.esc);
		assert.deepStrictEqual(events, ["cancel"]);
	});

	it("turns pasted line breaks and tabs into spaces and drops the paste markers", () => {
		const view = new ListView<string>({ items: ["a b"], row: (i) => i, maxRows: 5, theme, search: { text: (i) => i } });
		view.handleInput("\x1b[200~a\nb\tc\r\nd\x1b[201~");
		assert.strictEqual(view.getQuery(), "a b c d");
	});

	it("backspace deletes one grapheme, not one code point", () => {
		const view = new ListView<string>({ items: ["x"], row: (i) => i, maxRows: 5, theme, search: { text: (i) => i } });
		view.handleInput("a");
		view.handleInput("e\u0301");
		view.handleInput("👍🏽");
		view.handleInput("\x7f");
		assert.strictEqual(view.getQuery(), "ae\u0301");
		view.handleInput("\x7f");
		assert.strictEqual(view.getQuery(), "a");
	});

	it("counts the search line when it maps a click to an item", () => {
		const view = new ListView<string>({
			items: names(3),
			row: (i) => i,
			maxRows: 5,
			theme,
			search: { text: (i) => i },
		});
		view.render(40);
		view.handleMouse(mouse("press", 2));
		assert.strictEqual(view.getSelectedIndex(), 1);
		assert.strictEqual(view.handleMouse(mouse("press", 0)), undefined, "the search line is not an item");
	});

	it("confirms on the first click with clickConfirms first", () => {
		const { view, events, lines } = list(5, { clickConfirms: "first" });
		lines();
		view.handleMouse(mouse("press", 3));
		view.handleMouse(mouse("click", 3));
		assert.deepStrictEqual(events, ["select item 4"]);
	});

	it("jumps to the first and the last item with home and end", () => {
		const { view, lines } = list(30);
		const changes: string[] = [];
		view.onSelectionChange = (item) => changes.push(item);
		view.handleInput(KEYS.end);
		assert.strictEqual(view.getSelectedIndex(), 29);
		assert.deepStrictEqual(lines().slice(-2), ["› item 30", "  26–30/30"]);
		view.handleInput(KEYS.end);
		view.handleInput(KEYS.home);
		assert.strictEqual(view.getSelectedIndex(), 0);
		assert.strictEqual(lines().at(-1)?.trim(), "1–5/30");
		view.handleInput("\x1bOF");
		assert.strictEqual(view.getSelectedIndex(), 29, "the SS3 end sequence");
		view.handleInput("\x1bOH");
		assert.strictEqual(view.getSelectedIndex(), 0, "the SS3 home sequence");
		assert.deepStrictEqual(changes, ["item 30", "item 1", "item 30", "item 1"], "no change event when already there");
	});

	it("clamps home and end even when up and down wrap, and keeps them out of the search", () => {
		const wrapping = list(4, { wrap: true });
		wrapping.view.handleInput(KEYS.end);
		wrapping.view.handleInput(KEYS.end);
		assert.strictEqual(wrapping.view.getSelectedIndex(), 3);
		const searching = list(12, { search: { text: (item) => item } });
		searching.view.handleInput("1");
		searching.view.handleInput(KEYS.end);
		assert.strictEqual(searching.view.getQuery(), "1");
		assert.strictEqual(searching.view.getSelectedItem(), searching.view.getItems().at(-1));
		assert.strictEqual(list(0).view.getSelectedItem(), undefined);
		list(0).view.handleInput(KEYS.end);
	});

	it("marks only the first line of a two-line row and maps clicks by drawn heights across renders", () => {
		const view = new ListView<string>({
			items: names(4),
			row: (item) => [item, `  ${item} detail`],
			maxRows: 3,
			theme,
		});
		const draw = () => view.render(40).map((line) => stripTerminalSequences(line));
		assert.deepStrictEqual(draw().slice(0, 4), ["› item 1", "    item 1 detail", "  item 2", "    item 2 detail"]);
		view.handleMouse(mouse("press", 3));
		assert.strictEqual(view.getSelectedIndex(), 1, "row 3 is item 2's second line");
		view.handleInput(KEYS.end);
		const lines = draw();
		assert.deepStrictEqual(lines.slice(-3), ["› item 4", "    item 4 detail", "  2–4/4"]);
		view.handleMouse(mouse("press", 0));
		assert.strictEqual(view.getSelectedIndex(), 1, "the first row in view after scrolling");
	});

	it("keeps a fitting foot whole and cuts a wide hint to the width", () => {
		const wide = list(30, { hint: "选择 · 确认 · 取消 · 切换" });
		assert.strictEqual(wide.lines(60).at(-1), "  1–5/30  选择 · 确认 · 取消 · 切换");
		for (const width of [12, 20, 26, 27]) {
			const foot = wide.view.render(width).at(-1) ?? "";
			assert.ok(visibleWidth(foot) <= width, `${width}: the foot fits`);
		}
		assert.strictEqual(list(3, { hint: "esc close" }).lines().at(-1), "  esc close", "a hint alone, no position");
	});

	it("cuts every line to widths 1–10, marked rows included", () => {
		const rows: Partial<ListViewOptions<string>>[] = [
			{},
			// Rows that ignore their width: styled, wide characters, two lines.
			{ row: (item) => `\x1b[1m${item} with a long tail\x1b[22m` },
			{ row: (item) => [`${item} 宽字符宽字符`, "second line of the row"] },
			{ search: { text: (item) => item, placeholder: "type to search" }, hint: "enter select · esc cancel" },
		];
		for (const options of rows) {
			const { view } = list(12, options);
			view.handleInput(KEYS.down);
			for (let width = 1; width <= 10; width++) {
				for (const line of view.render(width)) {
					assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
				}
			}
		}
		const { lines } = list(2);
		assert.deepStrictEqual(lines(1), ["›", " "], "width 1 keeps the cursor");
		assert.deepStrictEqual(lines(4), ["› i…", "  i…"]);
	});

	it("enter confirms the selected item", () => {
		const { view, events } = list(3);
		view.handleInput(KEYS.down);
		view.handleInput(KEYS.enter);
		assert.deepStrictEqual(events, ["select item 2"]);
	});
});
