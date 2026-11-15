import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { ResizeDebounce } from "../src/tui/resize-debounce.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class WidthLog implements Component {
	widths: number[] = [];
	render(width: number): string[] {
		this.widths.push(width);
		return [`width ${width}`];
	}
	invalidate(): void {}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("resize coalescing", () => {
	it("renders once at the final size after a burst of resizes", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TuiMainScreen(terminal);
		const log = new WidthLog();
		tui.addChild(log);
		tui.start();
		tui.renderNow();
		log.widths.length = 0;

		// One synchronous burst: real sleeps between events race the debounce window on a loaded machine.
		for (let i = 0; i < 20; i++) terminal.resize(40 + i, 10);
		await sleep(200);

		assert.deepStrictEqual(log.widths, [59]);
		const viewport = (await terminal.flushAndGetViewport()).join("\n");
		assert.ok(viewport.includes("width 59"));
		tui.stop();
	});

	it("fires a lone resize after the short wait", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		let fired = 0;
		const debounce = new ResizeDebounce(() => fired++, { delayMs: 12 });
		debounce.trigger();
		t.mock.timers.tick(11);
		assert.strictEqual(fired, 0);
		t.mock.timers.tick(1);
		assert.strictEqual(fired, 1);
		t.mock.timers.tick(500);
		assert.strictEqual(fired, 1);
	});

	it("keeps the first frame of a burst on time, then waits for the burst to pause", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		let fired = 0;
		const debounce = new ResizeDebounce(() => fired++, { delayMs: 12, burstDelayMs: 80, maxWaitMs: 250 });
		// Events every 4 ms: the first frame still fires 12 ms after the first event.
		for (let i = 0; i < 3; i++) {
			debounce.trigger();
			t.mock.timers.tick(4);
		}
		t.mock.timers.tick(0);
		assert.strictEqual(fired, 1);
		// The drag goes on (last event at 60 ms): no frame at every step, one 80 ms after it stops.
		for (let at = 16; at <= 60; at += 4) {
			t.mock.timers.tick(at - Date.now());
			debounce.trigger();
		}
		t.mock.timers.tick(79);
		assert.strictEqual(fired, 1);
		t.mock.timers.tick(1);
		assert.strictEqual(fired, 2);
		t.mock.timers.tick(500);
		assert.strictEqual(fired, 2);
	});

	it("repaints at the max wait while a burst never pauses", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		const firedAt: number[] = [];
		const debounce = new ResizeDebounce(() => firedAt.push(Date.now()), {
			delayMs: 12,
			burstDelayMs: 80,
			maxWaitMs: 250,
		});
		// An event every 16 ms until 592 ms, time advancing 1 ms at a time so each frame records its own time.
		for (let at = 0; at < 800; at++) {
			if (at <= 600 && at % 16 === 0) debounce.trigger();
			t.mock.timers.tick(1);
		}
		assert.deepStrictEqual(firedAt, [12, 262, 512, 672]);
	});

	it("fires again for a resize after the quiet time", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		let fired = 0;
		const debounce = new ResizeDebounce(() => fired++, { delayMs: 12, burstDelayMs: 80 });
		debounce.trigger();
		t.mock.timers.tick(100);
		debounce.trigger();
		t.mock.timers.tick(12);
		assert.strictEqual(fired, 2);
	});

	it("paints at the last settled width while a resize waits, then replays once", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TuiMainScreen(terminal);
		const log = new WidthLog();
		tui.addChild(log);
		tui.start();
		tui.renderNow();
		const before = tui.fullRedraws;
		log.widths.length = 0;

		// Frames another source asks for (a spinner, a stream) during the drag: none renders at an intermediate width.
		for (let i = 0; i < 20; i++) {
			terminal.resize(70 - i, 10);
			(tui as unknown as { doRender(): void }).doRender();
		}
		assert.deepStrictEqual(new Set(log.widths), new Set([80]));
		assert.strictEqual(tui.fullRedraws, before);

		await sleep(200);
		assert.strictEqual(log.widths.at(-1), 51);
		assert.ok(log.widths.slice(20).every((width) => width === 51));
		assert.strictEqual(tui.fullRedraws, before + 1);
		tui.stop();
	});

	it("an explicit paint settles the waiting resize at the current size", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TuiMainScreen(terminal);
		const log = new WidthLog();
		tui.addChild(log);
		tui.start();
		tui.renderNow();
		const before = tui.fullRedraws;

		terminal.resize(50, 10);
		tui.renderNow();
		assert.strictEqual(log.widths.at(-1), 50);
		assert.strictEqual(tui.fullRedraws, before + 1);
		const painted = log.widths.length;
		await sleep(150);
		assert.strictEqual(log.widths.length, painted, "the settled resize does not paint again");
		tui.stop();
	});

	it("reports a resize as pending until its frame", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		const debounce = new ResizeDebounce(() => {}, { delayMs: 12 });
		assert.strictEqual(debounce.pending, false);
		debounce.trigger();
		assert.strictEqual(debounce.pending, true);
		t.mock.timers.tick(12);
		assert.strictEqual(debounce.pending, false);
		debounce.trigger();
		assert.strictEqual(debounce.flush(), true);
		assert.strictEqual(debounce.flush(), false);
		t.mock.timers.tick(500);
	});

	it("does not render after stop", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TuiMainScreen(terminal);
		const log = new WidthLog();
		tui.addChild(log);
		tui.start();
		tui.renderNow();
		terminal.resize(50, 10);
		tui.stop();
		log.widths.length = 0;
		await sleep(150);
		assert.deepStrictEqual(log.widths, []);
	});
});
