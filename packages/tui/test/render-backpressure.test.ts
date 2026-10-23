import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.ts";
import { computeRenderDelayMs, TuiBase } from "../src/tui.ts";

class PressureTerminal implements Terminal {
	pendingOutputBytes: number | undefined = 0;
	columns = 40;
	rows = 10;
	kittyProtocolActive = false;
	readonly writes: string[] = [];
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
}

class CountingTui extends TuiBase {
	readonly mode = "regular";
	painted: string[] = [];
	content = "initial";
	protected doRender(): void {
		this.painted.push(this.content);
		this.terminal.write(this.content);
	}
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("opt-in render pacing", () => {
	it("holds ordinary renders before composition, then paints the latest state once", async () => {
		const terminal = new PressureTerminal();
		const tui = new CountingTui(terminal);
		tui.setRenderPacing({
			outputGate: true,
			highWaterBytes: 256 * 1024,
			lowWaterBytes: 128 * 1024,
			retryMs: 10,
			metrics: true,
		});
		tui.start();
		tui.renderNow();
		terminal.pendingOutputBytes = 300 * 1024;
		for (let i = 0; i < 8; i++) {
			tui.content = `update-${i}`;
			tui.requestRender();
		}
		await pause(45);
		assert.deepEqual(tui.painted, ["initial"]);
		assert.ok(tui.getRenderPacingStats().deferredFrames > 0);
		terminal.pendingOutputBytes = 100 * 1024;
		await pause(45);
		assert.deepEqual(tui.painted, ["initial", "update-7"]);
		tui.stop();
	});

	it("keeps the legacy path for absent or invalid pressure metrics", async () => {
		for (const pending of [undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
			const terminal = new PressureTerminal();
			terminal.pendingOutputBytes = pending;
			const tui = new CountingTui(terminal);
			tui.setRenderPacing({ outputGate: true, retryMs: 10 });
			tui.start();
			tui.renderNow();
			tui.content = "changed";
			tui.requestRender();
			await pause(35);
			assert.deepEqual(tui.painted, ["initial", "changed"]);
			tui.stop();
		}
	});

	it("lets explicit paints bypass pressure and discards old retry callbacks on stop/restart", async () => {
		const terminal = new PressureTerminal();
		const tui = new CountingTui(terminal);
		tui.setRenderPacing({ outputGate: true, retryMs: 10 });
		tui.start();
		tui.renderNow();
		terminal.pendingOutputBytes = 300 * 1024;
		tui.content = "held";
		tui.requestRender();
		await pause(20);
		tui.content = "forced";
		tui.requestRender(true);
		await new Promise<void>((resolve) => process.nextTick(resolve));
		assert.equal(tui.painted.at(-1), "forced");
		tui.content = "now";
		tui.renderNow();
		assert.equal(tui.painted.at(-1), "now");
		const beforeStop = tui.painted.length;
		tui.stop();
		await pause(35);
		assert.equal(tui.painted.length, beforeStop);
		terminal.pendingOutputBytes = 0;
		tui.start();
		tui.renderNow();
		await pause(35);
		assert.equal(tui.painted.length, beforeStop + 1);
		tui.stop();
	});

	it("computes an adaptive floor independently of queue pressure", () => {
		assert.equal(computeRenderDelayMs(16, 0, 0, false), 16);
		assert.equal(computeRenderDelayMs(16, 100, 100, true), 100);
		assert.equal(computeRenderDelayMs(16, 5000, 5000, true), 0);
		assert.equal(computeRenderDelayMs(16, 5000, 0, true), 200);
	});
});
