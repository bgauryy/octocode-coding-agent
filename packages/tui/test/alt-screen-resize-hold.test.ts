import assert from "node:assert";
import { describe, it } from "node:test";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image/capabilities.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class WidthLog implements Component {
	widths: number[] = [];
	render(width: number): string[] {
		this.widths.push(width);
		return [`width ${width}`];
	}
	invalidate(): void {}
}

class WriteLog extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("alternate-screen resize", () => {
	it("paints at the last settled size while a resize waits, then repaints once", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TuiAltScreen(terminal);
		const log = new WidthLog();
		tui.addChild(log);
		tui.start();
		tui.renderNow();
		const before = tui.fullRedraws;
		log.widths.length = 0;

		// Frames another source asks for (a spinner, a stream) during the drag: none renders at an intermediate size.
		for (let i = 0; i < 20; i++) {
			terminal.resize(70 - i, 10);
			(tui as unknown as { doRender(): void }).doRender();
		}
		assert.deepStrictEqual(new Set(log.widths), new Set([80]));
		assert.strictEqual(tui.fullRedraws, before);

		await sleep(250);
		assert.strictEqual(log.widths.at(-1), 51);
		assert.strictEqual(tui.fullRedraws, before + 1);
		tui.stop();
	});
});

describe("alternate-screen full redraw", () => {
	it("does not blank the screen first when no image can be on it", async () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		try {
			const terminal = new WriteLog(40, 5);
			const tui = new TuiAltScreen(terminal);
			tui.addChild(new WidthLog());
			tui.start();
			tui.renderNow();
			terminal.writes.length = 0;
			terminal.resize(30, 5);
			tui.renderNow();
			const frame = terminal.writes.join("");
			assert.ok(frame.includes("width 30"), "the resize repainted");
			assert.ok(!frame.includes("\x1b[2J"), "no screen clear in the repaint");
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("clears the screen when images are supported", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new WriteLog(40, 5);
			const tui = new TuiAltScreen(terminal);
			tui.addChild(new WidthLog());
			tui.start();
			tui.renderNow();
			terminal.writes.length = 0;
			terminal.resize(30, 5);
			tui.renderNow();
			assert.ok(terminal.writes.join("").includes("\x1b[2J"));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});
});
