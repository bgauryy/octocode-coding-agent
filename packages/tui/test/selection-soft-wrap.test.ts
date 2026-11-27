import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { getSelectionText } from "../src/tui-alt-screen/selection.ts";
import { WRAP_SPACE_MARK, withSoftWrapMarks } from "../src/utils/row-marks.ts";
import { wrapTextWithAnsi } from "../src/utils/wrap.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Drag from the first cell of `fromRow` to the last cell of `toRow` (0-based rows) and return what was copied. */
async function dragCopy(
	width: number,
	height: number,
	add: (tui: TuiAltScreen) => void,
	fromRow: number,
	toRow: number,
): Promise<{ copied: string[]; flashes: string[]; screen: string[] }> {
	const terminal = new VirtualTerminal(width, height);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	const flashes: string[] = [];
	const flash = tui.flash.bind(tui);
	tui.flash = (message, durationMs) => {
		flashes.push(message);
		flash(message, durationMs);
	};
	add(tui);
	tui.start();
	await terminal.waitForRender();
	const screen = tui.getScreenLines();
	terminal.sendInput(`\x1b[<0;1;${fromRow + 1}M`);
	terminal.sendInput(`\x1b[<32;${width};${toRow + 1}M`);
	terminal.sendInput(`\x1b[<0;${width};${toRow + 1}m`);
	await terminal.waitForRender();
	await new Promise<void>((resolve) => setImmediate(resolve));
	tui.stop();
	return { copied, flashes, screen };
}

describe("soft-wrap marks", () => {
	it("mark rows broken at a space only while scroll-view content renders", () => {
		// A component's own render (a footer, a panel, an export) stays free of marks.
		assert.deepEqual(wrapTextWithAnsi("alpha bravo charlie", 12), ["alpha bravo", "charlie"]);
		assert.deepEqual(
			withSoftWrapMarks(() => wrapTextWithAnsi("alpha bravo charlie", 12)),
			["alpha bravo", `${WRAP_SPACE_MARK}charlie`],
		);
		// Trailing whitespace past the width adds no marked empty row.
		assert.deepEqual(
			withSoftWrapMarks(() => wrapTextWithAnsi("alpha bravo ", 11)),
			["alpha bravo"],
		);
	});

	it("leave a component rendered outside a scroll view unmarked", () => {
		const lines = new Markdown("alpha bravo charlie delta echo", 1, 0, defaultMarkdownTheme).render(14);
		assert.ok(lines.length > 1);
		assert.ok(
			lines.every((line) => !line.includes(WRAP_SPACE_MARK)),
			JSON.stringify(lines),
		);
	});
});

describe("copying soft-wrapped rows", () => {
	it("copies a paragraph the width wrapped as one line, without the component's padding", async () => {
		const prose = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
		const { copied, screen } = await dragCopy(
			24,
			8,
			(tui) => tui.addChild(new Markdown(prose, 1, 0, defaultMarkdownTheme)),
			0,
			3,
		);
		// Four drawn rows, each behind one column of padding.
		assert.ok(
			screen.slice(0, 4).every((row) => /^ \S/.test(row)),
			JSON.stringify(screen),
		);
		assert.deepEqual(copied, [prose]);
	});

	it("keeps hard line breaks and blank lines between paragraphs", async () => {
		const { copied } = await dragCopy(
			20,
			10,
			(tui) => tui.addChild(new Markdown("one two three four five six\n\nseven eight", 1, 0, defaultMarkdownTheme)),
			0,
			4,
		);
		assert.deepEqual(copied, ["one two three four five six\n\nseven eight"]);
	});

	it("joins a word the width cut without adding a space", async () => {
		const { copied } = await dragCopy(12, 6, (tui) => tui.addChild(new Text("abcdefghijklmnopqrstuvwxyz", 1, 0)), 0, 2);
		assert.deepEqual(copied, ["abcdefghijklmnopqrstuvwxyz"]);
	});

	it("keeps relative indentation while dropping the shared padding", async () => {
		const { copied } = await dragCopy(30, 8, (tui) => tui.addChild(new Text("top\n  nested\nback", 2, 0)), 0, 2);
		assert.deepEqual(copied, ["top\n  nested\nback"]);
	});

	it("reads rows of a plain screen without marks as separate lines", () => {
		const rows = ["  first row", "  second row"];
		assert.equal(
			getSelectionText({ start: { row: 0, col: 0 }, end: { row: 1, col: 11 } }, rows, undefined),
			"first row\nsecond row",
		);
	});

	it("drops only the padding left of a copy that starts inside its first row", () => {
		const rows = ["  alpha beta", "  gamma"];
		assert.equal(
			getSelectionText({ start: { row: 0, col: 8 }, end: { row: 1, col: 6 } }, rows, undefined),
			"beta\ngamma",
		);
	});
});
