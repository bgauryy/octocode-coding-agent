import assert from "node:assert";
import { describe, it } from "node:test";
import { ansiCodeLength } from "../src/utils/ansi-codes.ts";
import { extractCursorPosition } from "../src/tui/cursor.ts";
import { type Component, CURSOR_MARKER, FAKE_CURSOR_START, renderFakeCursor } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils/width.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	written: string[] = [];
	override write(data: string): void {
		this.written.push(data);
		super.write(data);
	}
	get output(): string {
		return this.written.join("");
	}
}

const rows = (lines: string[]): Component => ({ render: () => lines, invalidate() {} });

describe("cursor marker", () => {
	it("ends with the string terminator, which every terminal accepts for APC, not BEL", () => {
		assert.ok(CURSOR_MARKER.startsWith("\x1b_"));
		assert.ok(CURSOR_MARKER.endsWith("\x1b\\"));
		assert.ok(!CURSOR_MARKER.includes("\x07"));
		assert.ok(!FAKE_CURSOR_START.includes("\x07"));
		assert.ok(!renderFakeCursor("x").includes("\x07"));
	});

	it("is one zero-width escape sequence", () => {
		assert.strictEqual(ansiCodeLength(CURSOR_MARKER, 0), CURSOR_MARKER.length);
		assert.strictEqual(visibleWidth(`ab${CURSOR_MARKER}cd`), 4);
	});

	it("extractCursorPosition strips every marker, above the viewport and repeated, and reports the bottom-most", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `row ${i}`);
		lines[1] = `top${CURSOR_MARKER}`;
		lines[7] = `ab${CURSOR_MARKER}cd`;
		lines[9] = `xyz${CURSOR_MARKER}${CURSOR_MARKER}`;
		const position = extractCursorPosition(lines, 4);
		assert.deepStrictEqual(position, { row: 9, col: 3 });
		assert.ok(lines.every((line) => !line.includes("octo:")));
		assert.strictEqual(lines[1], "top");
		assert.strictEqual(lines[7], "abcd");
	});

	it("extractCursorPosition strips a marker that only exists above the viewport and finds no cursor", () => {
		const lines = [`a${CURSOR_MARKER}`, "b", "c", "d"];
		assert.strictEqual(extractCursorPosition(lines, 2), null);
		assert.deepStrictEqual(lines, ["a", "b", "c", "d"]);
	});

	it("the main screen never writes a marker above the viewport to the terminal", () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const lines = Array.from({ length: 30 }, (_, i) => `row ${i}`);
		lines[3] = `row 3${CURSOR_MARKER}`;
		tui.addChild(rows(lines));
		tui.start();
		tui.renderNow();
		tui.stop();
		assert.ok(!terminal.output.includes("octo:"), "marker reached the terminal");
	});

	it("the alt screen never writes a second marker to the terminal", () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(rows([`one${CURSOR_MARKER}`, `two${CURSOR_MARKER}`, "three"]));
		tui.start();
		tui.renderNow();
		tui.stop();
		assert.ok(!terminal.output.includes("octo:"), "marker reached the terminal");
	});
});
