import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { FinishedLines } from "../src/tui/clip.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	written: string[] = [];

	override write(data: string): void {
		this.written.push(data);
		super.write(data);
	}
}

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

describe("finishing rows once", () => {
	it("calls finish only for rows that changed, and again for all on a new width", () => {
		const finished: string[] = [];
		const lines = new FinishedLines((line, width) => {
			finished.push(line);
			return `${line}|${width}`;
		});
		assert.deepStrictEqual(lines.apply(["a", "b"], 10), ["a|10", "b|10"]);
		assert.deepStrictEqual(finished, ["a", "b"]);
		finished.length = 0;
		assert.deepStrictEqual(lines.apply(["a", "c", "d"], 10), ["a|10", "c|10", "d|10"]);
		assert.deepStrictEqual(finished, ["c", "d"]);
		finished.length = 0;
		assert.deepStrictEqual(lines.apply(["a", "c", "d"], 8), ["a|8", "c|8", "d|8"]);
		assert.deepStrictEqual(finished, ["a", "c", "d"]);
	});

	it("does not hand back the array it remembers", () => {
		const lines = new FinishedLines((line) => line.toUpperCase());
		const first = lines.apply(["a"], 10);
		first[0] = "changed";
		assert.deepStrictEqual(lines.apply(["a"], 10), ["A"]);
	});

	it("writes only the new row of a long transcript", () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const rows = Array.from({ length: 2_000 }, (_, index) => `row ${index}`);
		const content = new Rows(rows);
		tui.addChild(content);
		tui.start();
		try {
			tui.renderNow();
			const bytes = terminal.written.join("").length;
			content.lines = [...rows, "new row"];
			tui.renderNow();
			// Only the new row is written, whatever the transcript's length.
			const added = terminal.written.join("").length - bytes;
			assert.ok(added < 200, `wrote ${added} characters`);
			assert.ok(terminal.written.join("").includes("new row"));
		} finally {
			tui.stop();
		}
	});
});

describe("main screen over-wide rows", () => {
	it("clips an over-wide row on a differential render instead of throwing", () => {
		const terminal = new RecordingTerminal(20, 10);
		const tui = new TuiMainScreen(terminal);
		const rows = new Rows(["short", "ok", "tail"]);
		tui.addChild(rows);
		tui.start();
		tui.renderNow();
		terminal.written.length = 0;

		rows.lines = ["short", "x".repeat(25), "tail"];
		assert.doesNotThrow(() => tui.renderNow());
		const output = terminal.written.join("");
		assert.ok(output.includes("x".repeat(20)));
		assert.ok(!output.includes("x".repeat(21)));
		tui.stop();
	});

	it("clips an over-wide row on the first full render", () => {
		const terminal = new RecordingTerminal(20, 10);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new Rows(["short", "x".repeat(25), "tail"]));
		tui.start();
		tui.renderNow();
		const output = terminal.written.join("");
		assert.ok(output.includes("x".repeat(20)));
		assert.ok(!output.includes("x".repeat(21)), "the row was written unclipped");
		tui.stop();
	});

	it("keeps the scrollback clear on a width change and clips to the new width", () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new Rows(["head", "y".repeat(40), "tail"]));
		tui.start();
		tui.renderNow();
		terminal.written.length = 0;

		terminal.resize(30, 10);
		tui.renderNow();
		const output = terminal.written.join("");
		assert.ok(output.includes("\x1b[3J"), "scrollback is cleared so the reflowed transcript is not duplicated");
		assert.ok(output.includes("y".repeat(30)));
		assert.ok(!output.includes("y".repeat(31)));
		tui.stop();
	});
});
