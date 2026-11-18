import assert from "node:assert";
import { describe, it } from "node:test";
import { CURSOR_MARKER } from "../src/tui/cursor.ts";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { QaTerminal } from "./helpers/capture-terminal.ts";

const BEGIN = "\x1b[?2026h";
const END = "\x1b[?2026l";
const CURSOR = /\x1b\[\?25[hl]/;

class Rows implements Component {
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

const transcript = (count: number, tail = "") =>
	Array.from({ length: count }, (_, i) => `row ${i}${i === count - 1 ? tail : ""}`);

function setup(lines: string[], showCursor: boolean) {
	const terminal = new QaTerminal(40, 10);
	const tui = new TuiMainScreen(terminal);
	tui.setShowHardwareCursor(showCursor);
	const rows = new Rows(lines);
	tui.addChild(rows);
	tui.start();
	return { terminal, tui, rows };
}

/** Every write of one frame; a frame writes once: rows, cursor move and visibility inside one ?2026 pair. */
function frameWrites(terminal: QaTerminal, paint: () => void): string[] {
	const from = terminal.writes.length;
	paint();
	return terminal.writes.slice(from);
}

function assertOneFrame(writes: string[], visible: boolean): void {
	assert.strictEqual(writes.length, 1, `one write per frame, got ${JSON.stringify(writes)}`);
	const [frame] = writes;
	assert.ok(frame.startsWith(BEGIN), "the frame opens synchronized output");
	assert.ok(frame.endsWith(END), "the frame closes synchronized output last");
	const cursor = frame.lastIndexOf(visible ? "\x1b[?25h" : "\x1b[?25l");
	assert.ok(cursor > frame.indexOf(BEGIN) && cursor < frame.lastIndexOf(END), "the cursor sits inside ?2026");
	assert.strictEqual(frame.indexOf(END), frame.length - END.length, "no ?2026l before the cursor");
}

describe("main screen frame write", () => {
	it("writes the first frame, a changed row, an appended row and a deleted row once each, cursor inside ?2026", () => {
		const { terminal, tui, rows } = setup(transcript(3, CURSOR_MARKER), true);
		assertOneFrame(
			frameWrites(terminal, () => tui.renderNow()),
			true,
		);
		rows.lines = ["row 0 changed", ...transcript(3, CURSOR_MARKER).slice(1)];
		assertOneFrame(
			frameWrites(terminal, () => tui.renderNow()),
			true,
		);
		rows.lines = transcript(5, CURSOR_MARKER);
		assertOneFrame(
			frameWrites(terminal, () => tui.renderNow()),
			true,
		);
		rows.lines = transcript(2, CURSOR_MARKER);
		assertOneFrame(
			frameWrites(terminal, () => tui.renderNow()),
			true,
		);
		tui.stop();
	});

	it("hides the cursor inside the frame when there is no cursor position", () => {
		const { terminal, tui, rows } = setup(transcript(3), false);
		assertOneFrame(
			frameWrites(terminal, () => tui.renderNow()),
			false,
		);
		rows.lines = transcript(4);
		assertOneFrame(
			frameWrites(terminal, () => tui.renderNow()),
			false,
		);
		tui.stop();
	});

	it("writes a full redraw once with the cursor inside ?2026", () => {
		const { terminal, tui, rows } = setup(transcript(30, CURSOR_MARKER), true);
		tui.setClearOnShrink(true);
		tui.renderNow();
		const before = tui.fullRedraws;
		rows.lines = transcript(20, CURSOR_MARKER);
		const writes = frameWrites(terminal, () => tui.renderNow());
		assert.strictEqual(tui.fullRedraws, before + 1, "a shrink with clearOnShrink replays");
		assert.ok(writes[0]?.includes("\x1b[2J"), "the replay clears the screen");
		assertOneFrame(writes, true);
		tui.stop();
	});

	it("writes only the cursor, once, when the rows did not change", () => {
		const { terminal, tui } = setup(transcript(3, CURSOR_MARKER), true);
		tui.renderNow();
		const writes = frameWrites(terminal, () => tui.renderNow(true));
		assert.ok(writes.length <= 1, `at most one write, got ${JSON.stringify(writes)}`);
		for (const write of writes) assert.match(write, CURSOR);
		tui.stop();
	});

	it("places the hardware cursor at the marker", async () => {
		const { terminal, tui } = setup(["first", `ab${CURSOR_MARKER}cd`], true);
		tui.renderNow();
		await new Promise<void>((resolve) => terminal.emulator.write("", resolve));
		const buffer = terminal.emulator.buffer.active;
		assert.deepStrictEqual([buffer.cursorY, buffer.cursorX], [1, 2]);
		tui.stop();
	});
});
