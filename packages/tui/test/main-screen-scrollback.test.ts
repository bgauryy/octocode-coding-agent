import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Container } from "../src/tui/container.ts";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Records every write so frames and scrollback clears can be counted. */
class RecordingTerminal extends VirtualTerminal {
	readonly chunks: string[] = [];
	override write(data: string): void {
		this.chunks.push(data);
		super.write(data);
	}
	get frames(): number {
		return this.chunks.filter((chunk) => chunk.includes("\x1b[?2026h")).length;
	}
	get scrollbackClears(): number {
		return this.chunks.filter((chunk) => chunk.includes("\x1b[3J")).length;
	}
}

/** One leaf of the transcript: a fixed number of rows with changeable text. */
class Rows implements Component {
	text: string;
	rows: number;
	constructor(text: string, rows = 1) {
		this.text = text;
		this.rows = rows;
	}
	render(): string[] {
		return Array.from({ length: this.rows }, (_, i) => (i === 0 ? this.text : `${this.text} (${i})`));
	}
	invalidate(): void {}
}

const HEIGHT = 10;

/**
 * A transcript like the app's: a live row at the top (an elapsed timer, a subagent status), a long history, and a
 * tall dialog at the bottom that pushes the live row far above the viewport.
 */
function setup() {
	const terminal = new RecordingTerminal(60, HEIGHT);
	const tui = new TuiMainScreen(terminal);
	const chat = new Container();
	const live = new Rows("tool 0s");
	chat.addChild(live);
	for (let i = 0; i < 40; i++) chat.addChild(new Rows(`history ${i}`));
	const spinner = new Rows("working ⠋");
	const dialog = new Container();
	const question = new Rows("Allow this command?");
	const choices = new Rows("1. Allow once", 4);
	dialog.addChild(question);
	dialog.addChild(choices);
	tui.addChild(chat);
	tui.addChild(spinner);
	tui.addChild(dialog);
	tui.start();
	tui.renderNow();
	return { terminal, tui, chat, live, spinner, dialog, question, choices };
}

const visible = async (terminal: VirtualTerminal): Promise<string[]> =>
	(await terminal.flushAndGetViewport()).map((row) => row.trimEnd());

describe("main screen: scrollback is immutable", () => {
	it("a ticking row above the viewport costs no replay and no frame while the visible rows stay the same", async () => {
		const { terminal, tui, live } = setup();
		await terminal.flush();
		const replays = tui.fullRedraws;
		const frames = terminal.frames;
		const clears = terminal.scrollbackClears;
		const before = await visible(terminal);

		for (let second = 1; second <= 8; second++) {
			live.text = `tool ${second}s`;
			tui.renderNow();
		}

		assert.strictEqual(tui.fullRedraws, replays, "no full replay");
		assert.strictEqual(terminal.scrollbackClears, clears, "scrollback is never cleared");
		assert.strictEqual(terminal.frames, frames, "nothing is written when the visible rows are unchanged");
		assert.deepStrictEqual(await visible(terminal), before);
		assert.strictEqual(tui.renderCounters.deferredAboveViewport, 8);
		tui.stop();
	});

	it("a ticking row above the viewport and a spinner in view repaint only the spinner", async () => {
		const { terminal, tui, live, spinner } = setup();
		await terminal.flush();
		const replays = tui.fullRedraws;
		const clears = terminal.scrollbackClears;

		for (let tick = 1; tick <= 6; tick++) {
			live.text = `tool ${tick}s`;
			spinner.text = `working ${tick}`;
			tui.renderNow();
		}

		assert.strictEqual(tui.fullRedraws, replays);
		assert.strictEqual(terminal.scrollbackClears, clears);
		const rows = await visible(terminal);
		assert.ok(rows.includes("working 6"), "the visible spinner row is current");
		assert.strictEqual(rows.length, HEIGHT);
		tui.stop();
	});

	it("a box whose children are rebuilt on every tick (a tool row) is still an in-place edit", async () => {
		const { terminal, tui, chat } = setup();
		const box = new Box(1, 0);
		chat.children.splice(3, 1, box);
		const tick = (text: string) => {
			box.clear();
			box.addChild(new Rows(text));
		};
		tick("tool 0s");
		tui.renderNow();
		await terminal.flush();
		const replays = tui.fullRedraws;
		const frames = terminal.frames;
		for (let second = 1; second <= 5; second++) {
			tick(`tool ${second}s`);
			tui.renderNow();
		}
		assert.strictEqual(tui.fullRedraws, replays);
		assert.strictEqual(terminal.frames, frames);
		tui.stop();
	});

	it("a header row rebuilt as a new component of the same height above the viewport is an in-place edit", async () => {
		const { terminal, tui, chat } = setup();
		await terminal.flush();
		const replays = tui.fullRedraws;
		for (let tick = 1; tick <= 4; tick++) {
			chat.children.splice(0, 1, new Rows(`tool · model ${tick}`));
			tui.renderNow();
		}
		assert.strictEqual(tui.fullRedraws, replays, "a rebuilt status row does not replay scrollback");
		assert.strictEqual(tui.renderCounters.deferredAboveViewport, 4);
		tui.stop();
	});

	it("knows which components the terminal holds in scrollback above the viewport", () => {
		const { tui, chat, live, spinner, choices } = setup();
		assert.strictEqual(tui.isAboveViewport(live), true);
		assert.strictEqual(tui.isAboveViewport(chat.children[30]), true);
		assert.strictEqual(tui.isAboveViewport(spinner), false);
		assert.strictEqual(tui.isAboveViewport(choices), false);
		tui.stop();
	});

	it("an expansion toggle that skips the components above the viewport replays nothing and keeps the screen right", async () => {
		const { terminal, tui, chat, dialog, choices } = setup();
		const rows = [...chat.children, ...dialog.children] as Rows[];
		await terminal.flush();
		const replays = tui.fullRedraws;
		const clears = terminal.scrollbackClears;
		for (const expanded of [true, false, true]) {
			for (const row of rows) if (!tui.isAboveViewport(row)) row.rows = expanded ? 3 : 1;
			choices.rows = expanded ? 6 : 4;
			tui.renderNow();
			// The screen ends with the transcript's last rows; a shrink leaves blank rows below them, as any shrink does.
			const shown = await visible(terminal);
			while (shown.at(-1) === "") shown.pop();
			const rendered = tui.render(60).map((row) => row.trimEnd());
			assert.deepStrictEqual(shown, rendered.slice(-shown.length));
		}
		assert.strictEqual(tui.fullRedraws, replays, "no replay of the transcript");
		assert.strictEqual(terminal.scrollbackClears, clears, "scrollback is never cleared");
		tui.stop();
	});

	it("does not edit scrollback: the rows that scrolled off keep what the terminal already holds", async () => {
		const { terminal, tui, live } = setup();
		live.text = "tool 9s";
		tui.renderNow();
		await terminal.flush();
		const scrollback = terminal.getScrollBuffer().map((row) => row.trimEnd());
		assert.ok(scrollback.includes("tool 0s"), "the old row is still in scrollback");
		assert.ok(!scrollback.includes("tool 9s"));
		tui.stop();
	});

	it("a resize still repaints everything, with the edits that were deferred", async () => {
		const { terminal, tui, live } = setup();
		live.text = "tool 9s";
		tui.renderNow();
		const replays = tui.fullRedraws;

		terminal.resize(50, HEIGHT);
		tui.renderNow();
		await terminal.flush();

		assert.strictEqual(tui.fullRedraws, replays + 1);
		const scrollback = terminal.getScrollBuffer().map((row) => row.trimEnd());
		assert.ok(scrollback.includes("tool 9s"), "the repaint carries the latest text");
		assert.ok(!scrollback.includes("tool 0s"));
		tui.stop();
	});

	it("a height change still repaints", async () => {
		const { terminal, tui, live } = setup();
		live.text = "tool 3s";
		tui.renderNow();
		const replays = tui.fullRedraws;
		terminal.resize(60, HEIGHT + 4);
		tui.renderNow();
		assert.strictEqual(tui.fullRedraws, replays + 1);
		tui.stop();
	});

	it("a row added above the viewport moves the layout, so it replays once", async () => {
		const { terminal, tui, chat } = setup();
		const replays = tui.fullRedraws;
		chat.children.splice(5, 0, new Rows("subagent started"));
		tui.renderNow();
		await terminal.flush();
		assert.strictEqual(tui.fullRedraws, replays + 1);
		const scrollback = terminal.getScrollBuffer().map((row) => row.trimEnd());
		assert.ok(scrollback.includes("subagent started"));
		tui.stop();
	});

	it("a row that grows above the viewport moves the layout, so it replays once", async () => {
		const { tui, live } = setup();
		const replays = tui.fullRedraws;
		live.rows = 3;
		tui.renderNow();
		assert.strictEqual(tui.fullRedraws, replays + 1);
		tui.stop();
	});

	it("invalidate() means the look changed everywhere, so an edit above the viewport replays", async () => {
		const { tui, live } = setup();
		const replays = tui.fullRedraws;
		live.text = "themed";
		tui.invalidate();
		tui.renderNow();
		assert.strictEqual(tui.fullRedraws, replays + 1);
		// The intent is spent by the replay: the next in-place edit is deferred again.
		live.text = "themed 2";
		tui.renderNow();
		assert.strictEqual(tui.fullRedraws, replays + 1);
		tui.stop();
	});

	it("repaintScrollback() is the explicit request for a replay", async () => {
		const { tui, live } = setup();
		const replays = tui.fullRedraws;
		live.text = "tool done";
		tui.repaintScrollback();
		tui.renderNow();
		assert.strictEqual(tui.fullRedraws, replays + 1);
		tui.stop();
	});

	it("counts requests, painted frames and written frames", async () => {
		const { terminal, tui, live } = setup();
		await terminal.flush();
		const start = { ...tui.renderCounters };
		tui.requestRender();
		tui.requestRender();
		await new Promise((resolve) => setTimeout(resolve, 80));
		const idle = tui.renderCounters;
		assert.strictEqual(idle.requested - start.requested, 2);
		assert.strictEqual(idle.painted - start.painted, 1, "requests coalesce into one frame");
		assert.strictEqual(idle.written - start.written, 0, "an unchanged frame writes nothing");

		live.text = "tool 1s";
		tui.renderNow();
		assert.strictEqual(tui.renderCounters.written - start.written, 0, "an off-screen edit writes nothing");
		tui.stop();
	});
});
