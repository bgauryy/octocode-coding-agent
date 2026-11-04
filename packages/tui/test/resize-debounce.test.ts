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

	it("restarts the wait on each event and fires once, after the last", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let fired = 0;
		const debounce = new ResizeDebounce(() => fired++, 12);
		for (let i = 0; i < 5; i++) {
			debounce.trigger();
			t.mock.timers.tick(10);
		}
		assert.strictEqual(fired, 0);
		t.mock.timers.tick(1);
		assert.strictEqual(fired, 0);
		t.mock.timers.tick(1);
		assert.strictEqual(fired, 1);
		t.mock.timers.tick(100);
		assert.strictEqual(fired, 1);
	});

	it("fires again for a resize after the quiet time", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let fired = 0;
		const debounce = new ResizeDebounce(() => fired++, 12);
		debounce.trigger();
		t.mock.timers.tick(12);
		debounce.trigger();
		t.mock.timers.tick(12);
		assert.strictEqual(fired, 2);
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
