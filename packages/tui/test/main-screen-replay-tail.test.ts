import assert from "node:assert";
import { describe, it } from "node:test";
import { Container } from "../src/tui/container.ts";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { replayTail } from "../src/tui-main-screen/scrollback.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	written = "";
	override write(data: string): void {
		this.written += data;
		super.write(data);
	}
}

/** Wrapped text: its rows depend on the width, as a transcript entry's do. */
class Wrapped implements Component {
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(width: number): string[] {
		const rows: string[] = [];
		for (let start = 0; start < this.text.length; start += width) rows.push(this.text.slice(start, start + width));
		return rows;
	}
	invalidate(): void {}
}

function transcript(replayRows: number | undefined) {
	const terminal = new RecordingTerminal(40, 8);
	const tui = new TuiMainScreen(terminal);
	if (replayRows !== undefined) tui.setReplayRows(replayRows);
	const chat = new Container();
	for (let entry = 0; entry < 300; entry++) chat.addChild(new Wrapped(`entry ${entry} ${"word ".repeat(entry % 13)}`));
	tui.addChild(chat);
	tui.addChild(new Wrapped("> editor"));
	tui.start();
	tui.renderNow();
	return { terminal, tui };
}

const visible = async (terminal: VirtualTerminal): Promise<string[]> =>
	(await terminal.flushAndGetViewport()).map((row) => row.trimEnd());

describe("main screen: a replay writes a bounded tail", () => {
	it("keeps every row up to the bound, and the last rows behind one marker row past it", () => {
		const lines = Array.from({ length: 50 }, (_, row) => `row ${row}`);
		assert.strictEqual(replayTail(lines, 0, 10), lines, "0 replays every row");
		assert.strictEqual(replayTail(lines, 60, 10), lines);
		const tail = replayTail(lines, 20, 10);
		assert.strictEqual(tail.length, 21);
		assert.match(tail[0] ?? "", /30 earlier rows not redrawn/);
		assert.deepStrictEqual(tail.slice(1), lines.slice(30));
		assert.strictEqual(replayTail(lines, 3, 10).length, 11, "never fewer rows than a screen");
	});

	it("shows the same screen as a full replay after a width change and a forced redraw, writing a fraction", async () => {
		const bounded = transcript(40);
		const full = transcript(0);
		for (const { terminal } of [bounded, full]) {
			await terminal.flush();
			terminal.written = "";
		}
		for (const columns of [31, 40]) {
			for (const { terminal, tui } of [bounded, full]) {
				terminal.resize(columns, 8);
				tui.renderNow();
			}
			assert.deepStrictEqual(await visible(bounded.terminal), await visible(full.terminal), `width ${columns}`);
		}
		// The forced frame after a resume from the background (lifecycle `onResume`: requestRender(true)).
		for (const { tui } of [bounded, full]) tui.renderNow(true);
		assert.deepStrictEqual(await visible(bounded.terminal), await visible(full.terminal), "forced redraw");
		assert.ok(bounded.terminal.written.includes("earlier rows not redrawn"));
		assert.ok(!full.terminal.written.includes("earlier rows not redrawn"));
		assert.ok(
			bounded.terminal.written.length * 3 < full.terminal.written.length,
			`${bounded.terminal.written.length} vs ${full.terminal.written.length} bytes`,
		);
		// Frames after the replay diff against every row as before: an edit in view repaints in place.
		for (const { tui } of [bounded, full]) {
			tui.addChild(new Wrapped("new entry"));
			tui.renderNow();
		}
		assert.deepStrictEqual(await visible(bounded.terminal), await visible(full.terminal), "after an append");
		bounded.tui.stop();
		full.tui.stop();
	});
});
