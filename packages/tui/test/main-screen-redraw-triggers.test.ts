import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

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

const numbered = (count: number, from = 0): string[] => Array.from({ length: count }, (_, i) => `row ${from + i}`);

function setup(height: number, lines: string[]) {
	const terminal = new VirtualTerminal(40, height);
	const tui = new TuiMainScreen(terminal);
	const rows = new Rows(lines);
	tui.addChild(rows);
	tui.start();
	tui.renderNow();
	return { terminal, tui, rows };
}

const visible = async (terminal: VirtualTerminal): Promise<string[]> =>
	(await terminal.flushAndGetViewport()).map((r) => r.trimEnd());

describe("main screen redraw triggers", () => {
	it("does not clear scrollback when a visible line changes after the document grew past the height", async () => {
		const { terminal, tui, rows } = setup(10, numbered(5));
		rows.lines = numbered(30);
		tui.renderNow();
		const before = tui.fullRedraws;
		rows.lines = [...numbered(30).slice(0, 29), "row 29 changed"];
		tui.renderNow();
		assert.strictEqual(tui.fullRedraws, before);
		assert.deepStrictEqual(await visible(terminal), [...numbered(9, 20), "row 29 changed"]);
		tui.stop();
	});

	it("does not clear scrollback for a visible change after the document shrank and grew again", async () => {
		const { terminal, tui, rows } = setup(10, numbered(5));
		rows.lines = numbered(40);
		tui.renderNow();
		// Collapse a tail section (streamed output -> preview), keeping the visible head rows.
		rows.lines = [...numbered(33), "preview"];
		tui.renderNow();
		rows.lines = [...numbered(33), "preview", "spinner a"];
		tui.renderNow();
		const before = tui.fullRedraws;
		for (const frame of ["spinner b", "spinner c", "spinner d"]) {
			rows.lines = [...numbered(33), "preview", frame];
			tui.renderNow();
		}
		assert.strictEqual(tui.fullRedraws, before);
		// The terminal cannot scroll back after the shrink: rows stay where they were, with blank rows below the content.
		assert.deepStrictEqual(await visible(terminal), [...numbered(3, 30), "preview", "spinner d", "", "", "", "", ""]);
		tui.stop();
	});

	it("keeps the viewport rows right after a shrink that leaves blank rows below", async () => {
		const { terminal, tui, rows } = setup(10, numbered(40));
		const before = tui.fullRedraws;
		rows.lines = [...numbered(34), "tail"];
		tui.renderNow();
		assert.strictEqual(tui.fullRedraws, before);
		rows.lines = [...numbered(34), "tail 2"];
		tui.renderNow();
		assert.strictEqual(tui.fullRedraws, before);
		assert.ok((await visible(terminal)).includes("tail 2"));
		tui.stop();
	});

	it("still redraws when a row above the viewport changes", async () => {
		const { tui, rows } = setup(10, numbered(30));
		const before = tui.fullRedraws;
		rows.lines = ["changed", ...numbered(29, 1)];
		tui.renderNow();
		assert.strictEqual(tui.fullRedraws, before + 1);
		tui.stop();
	});

	it("still redraws when the document shrinks above the viewport", async () => {
		const { terminal, tui, rows } = setup(10, numbered(30));
		const before = tui.fullRedraws;
		rows.lines = numbered(12);
		tui.renderNow();
		assert.strictEqual(tui.fullRedraws, before + 1);
		assert.deepStrictEqual(await visible(terminal), [...numbered(10, 2)]);
		tui.stop();
	});
});
