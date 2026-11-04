import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
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

		for (let i = 0; i < 20; i++) {
			terminal.resize(40 + i, 10);
			await sleep(2);
		}
		await sleep(200);

		assert.deepStrictEqual(log.widths, [59]);
		const viewport = (await terminal.flushAndGetViewport()).join("\n");
		assert.ok(viewport.includes("width 59"));
		tui.stop();
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
