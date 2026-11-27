import assert from "node:assert";
import { describe, it } from "node:test";
import { Container } from "../src/tui/container.ts";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	bytes = 0;
	clears = 0;
	override write(data: string): void {
		this.bytes += data.length;
		if (data.includes("\x1b[3J")) this.clears += 1;
		super.write(data);
	}
}

class Rows implements Component {
	text: string;
	rows: number;
	constructor(text: string, rows = 1) {
		this.text = text;
		this.rows = rows;
	}
	render(): string[] {
		return Array.from({ length: this.rows }, (_, i) => (this.rows === 1 ? this.text : `${this.text} ${i}`));
	}
	invalidate(): void {}
}

const HEIGHT = 10;

/** History, one tool result expanded to 200 rows, then a few rows below it: the result's start is far above the screen. */
function setup() {
	const terminal = new RecordingTerminal(60, HEIGHT);
	const tui = new TuiMainScreen(terminal);
	const chat = new Container();
	for (let i = 0; i < 30; i++) chat.addChild(new Rows(`history ${i}`));
	const tool = new Rows("tool output", 200);
	chat.addChild(tool);
	for (let i = 0; i < 4; i++) chat.addChild(new Rows(`after ${i}`));
	tui.addChild(chat);
	tui.addChild(new Rows("editor", 3));
	tui.start();
	tui.renderNow();
	return { terminal, tui, chat, tool };
}

const screen = async (terminal: VirtualTerminal): Promise<string[]> => {
	const rows = (await terminal.flushAndGetViewport()).map((row) => row.trimEnd());
	while (rows.at(-1) === "") rows.pop();
	return rows;
};

describe("main screen: collapse above the screen", () => {
	it("an announced collapse keeps scrollback, repaints only the screen and leaves the live tail right", async () => {
		const { terminal, tui, tool } = setup();
		await terminal.flush();
		const replays = tui.fullRedraws;
		const clears = terminal.clears;
		const bytes = terminal.bytes;
		const scrollbackBefore = terminal.getScrollBuffer().length;

		tool.rows = 2;
		tui.keepScrollbackOnCollapse();
		tui.renderNow();

		assert.strictEqual(tui.fullRedraws, replays, "no replay");
		assert.strictEqual(terminal.clears, clears, "scrollback is not cleared");
		assert.ok(terminal.bytes - bytes < 600, `wrote ${terminal.bytes - bytes} bytes`);
		const shown = await screen(terminal);
		assert.deepStrictEqual(
			shown,
			tui
				.render(60)
				.map((row) => row.trimEnd())
				.slice(-shown.length),
		);
		assert.ok(terminal.getScrollBuffer().length >= scrollbackBefore, "the rows that scrolled off stay");
		tui.stop();
	});

	it("frames after a collapse diff against the screen as it is: edits and appends land on the right rows", async () => {
		const { terminal, tui, chat, tool } = setup();
		tool.rows = 2;
		tui.keepScrollbackOnCollapse();
		tui.renderNow();
		const replays = tui.fullRedraws;

		for (let i = 0; i < 3; i++) {
			chat.addChild(new Rows(`later ${i}`));
			tui.renderNow();
		}
		(chat.children.at(-1) as Rows).text = "edited";
		tui.renderNow();
		tool.rows = 1;
		tui.keepScrollbackOnCollapse();
		tui.renderNow();

		const shown = await screen(terminal);
		assert.deepStrictEqual(
			shown,
			tui
				.render(60)
				.map((row) => row.trimEnd())
				.slice(-shown.length),
		);
		assert.strictEqual(tui.fullRedraws, replays, "the later frames did not replay either");
		tui.stop();
	});

	it("a collapse that shrinks a whole screen's worth still repaints right", async () => {
		const { terminal, tui, chat, tool } = setup();
		tool.rows = 200;
		for (let i = 0; i < 5; i++) chat.addChild(new Rows(`tail ${i}`, 2));
		tui.renderNow();
		tool.rows = 1;
		tui.keepScrollbackOnCollapse();
		tui.renderNow();
		const shown = await screen(terminal);
		assert.deepStrictEqual(
			shown,
			tui
				.render(60)
				.map((row) => row.trimEnd())
				.slice(-shown.length),
		);
		tui.stop();
	});

	it("without the announcement a shrink above the screen still replays", async () => {
		const { terminal, tui, tool } = setup();
		const replays = tui.fullRedraws;
		tool.rows = 2;
		tui.renderNow();
		await terminal.flush();
		assert.strictEqual(tui.fullRedraws, replays + 1);
		tui.stop();
	});

	it("an announcement is spent by its frame", async () => {
		const { tui, tool } = setup();
		tui.keepScrollbackOnCollapse();
		tui.renderNow(); // nothing shrank: the announcement is used up
		const replays = tui.fullRedraws;
		tool.rows = 2;
		tui.renderNow();
		assert.strictEqual(tui.fullRedraws, replays + 1, "a later shrink replays");
		tui.stop();
	});

	it("repaintScrollback() still wins over an announced collapse", async () => {
		const { tui, tool } = setup();
		const replays = tui.fullRedraws;
		tool.rows = 2;
		tui.keepScrollbackOnCollapse();
		tui.repaintScrollback();
		tui.renderNow();
		assert.strictEqual(tui.fullRedraws, replays + 1);
		tui.stop();
	});

	it("a resize after a collapse repaints the transcript as it is now", async () => {
		const { terminal, tui, tool } = setup();
		tool.rows = 2;
		tui.keepScrollbackOnCollapse();
		tui.renderNow();
		const replays = tui.fullRedraws;
		terminal.resize(50, HEIGHT);
		tui.renderNow();
		assert.strictEqual(tui.fullRedraws, replays + 1);
		const shown = await screen(terminal);
		assert.deepStrictEqual(
			shown,
			tui
				.render(50)
				.map((row) => row.trimEnd())
				.slice(-shown.length),
		);
		const scrollback = terminal.getScrollBuffer().map((row) => row.trimEnd());
		assert.ok(!scrollback.includes("tool output 150"), "the replay drops the collapsed rows");
		tui.stop();
	});
});
