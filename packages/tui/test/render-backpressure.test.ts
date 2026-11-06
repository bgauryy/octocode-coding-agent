import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ProcessTerminal, type Terminal } from "../src/terminal.ts";
import { computeRenderDelayMs, TuiBase } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

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

class PressureVirtualTerminal extends VirtualTerminal {
	pendingOutputBytes = 0;
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until `done` holds, polling every 5ms; fails after `limitMs` so a held render cannot pass by timing. */
async function until(done: () => boolean, what: string, limitMs = 2000): Promise<void> {
	const deadline = Date.now() + limitMs;
	while (!done()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await pause(5);
	}
}

// A failed assertion must not skip stop(): a running retry timer keeps the test process alive forever.
const running: TuiBase[] = [];
const track = <T extends TuiBase>(tui: T): T => {
	running.push(tui);
	return tui;
};
afterEach(() => {
	for (const tui of running.splice(0)) tui.stop();
});

describe("opt-in render pacing", () => {
	it("counts output bytes and refused writes only when telemetry is enabled", () => {
		const terminal = new ProcessTerminal();
		const originalWrite = process.stdout.write;
		process.stdout.write = () => false;
		try {
			terminal.write("ignored");
			assert.equal(terminal.getOutputTelemetry().writtenBytes, 0);
			terminal.setOutputTelemetryEnabled(true);
			terminal.write("🙂");
			assert.deepEqual(terminal.getOutputTelemetry(), {
				writtenBytes: 4,
				writeCalls: 1,
				maxWriteBytes: 4,
				backpressuredWrites: 1,
				maxQueuedBytes: process.stdout.writableLength,
			});
		} finally {
			process.stdout.write = originalWrite;
		}
	});
	it("holds ordinary renders before composition, then paints the latest state once", async () => {
		const terminal = new PressureTerminal();
		const tui = track(new CountingTui(terminal));
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
		await until(() => tui.getRenderPacingStats().deferredFrames > 0, "a deferred frame");
		await pause(30);
		assert.deepEqual(tui.painted, ["initial"]);
		terminal.pendingOutputBytes = 100 * 1024;
		await until(() => tui.painted.length > 1, "the held paint");
		await pause(30);
		assert.deepEqual(tui.painted, ["initial", "update-7"]);
		tui.stop();
	});

	it("keeps the main-screen diff baseline aligned while obsolete states are deferred", async () => {
		const terminal = new PressureVirtualTerminal(40, 8);
		const tui = track(new TuiMainScreen(terminal));
		const component = {
			line: "initial",
			render() {
				return [this.line];
			},
			invalidate() {},
		};
		tui.addChild(component);
		tui.setRenderPacing({ outputGate: true, retryMs: 10 });
		tui.start();
		tui.renderNow();
		await terminal.flush();
		terminal.pendingOutputBytes = 300 * 1024;
		terminal.writes.length = 0;
		for (const value of ["obsolete-one", "obsolete-two", "latest"]) {
			component.line = value;
			tui.requestRender();
		}
		await pause(35);
		assert.equal(terminal.writes.length, 0);
		assert.equal((await terminal.flushAndGetViewport())[0], "initial");
		terminal.pendingOutputBytes = 0;
		await pause(35);
		assert.equal((await terminal.flushAndGetViewport())[0], "latest");
		assert.doesNotMatch(terminal.writes.join(""), /obsolete-one|obsolete-two/);
		tui.stop();
	});

	it("keeps the legacy path for absent or invalid pressure metrics", async () => {
		for (const pending of [undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
			const terminal = new PressureTerminal();
			terminal.pendingOutputBytes = pending;
			const tui = track(new CountingTui(terminal));
			tui.setRenderPacing({ outputGate: true, retryMs: 10 });
			tui.start();
			tui.renderNow();
			tui.content = "changed";
			tui.requestRender();
			await pause(70);
			assert.deepEqual(tui.painted, ["initial", "changed"]);
			tui.stop();
		}
	});

	it("lets explicit paints bypass pressure and discards old retry callbacks on stop/restart", async () => {
		const terminal = new PressureTerminal();
		const tui = track(new CountingTui(terminal));
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

	it("starts a fresh paint after a pre-start ordinary or forced request", async () => {
		for (const force of [false, true]) {
			const terminal = new PressureTerminal();
			const tui = track(new CountingTui(terminal));
			tui.content = force ? "force-before-start" : "ordinary-before-start";
			tui.requestRender(force);
			tui.start();
			await pause(35);
			assert.deepEqual(tui.painted, [tui.content]);
			tui.stop();
		}
	});

	it("computes an adaptive floor independently of queue pressure", () => {
		assert.equal(computeRenderDelayMs(16, 0, 0, false), 16);
		assert.equal(computeRenderDelayMs(16, 100, 100, true), 100);
		assert.equal(computeRenderDelayMs(16, 5000, 5000, true), 0);
		assert.equal(computeRenderDelayMs(16, 5000, 0, true), 200);
	});
});
