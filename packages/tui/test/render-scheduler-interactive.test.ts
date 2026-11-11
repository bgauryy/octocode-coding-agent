import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.ts";
import { RenderScheduler } from "../src/tui/render-scheduler.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function scheduler() {
	const frames: number[] = [];
	const terminal = { pendingOutputBytes: 0 } as unknown as Terminal;
	const s = new RenderScheduler({
		terminal: () => terminal,
		isStopped: () => false,
		paint: () => frames.push(performance.now()),
	});
	s.start();
	return { s, frames, terminal };
}

describe("RenderScheduler pointer frames", () => {
	it("paints a pointer frame well before the streaming cadence would", async () => {
		const { s, frames } = scheduler();
		s.paintNow();
		// Inside the interactive interval: the frame waits for the rest of it, not for the 40 ms cadence.
		s.requestInteractive();
		await wait(25);
		assert.equal(frames.length, 2);
		assert.ok(frames[1] - frames[0] < 30, `second frame after ${frames[1] - frames[0]} ms`);
		s.stop();
	});

	it("replaces a pending streaming frame and shares one frame between events of a burst", async () => {
		const { s, frames } = scheduler();
		s.paintNow();
		s.request();
		for (let i = 0; i < 20; i++) s.requestInteractive();
		await wait(25);
		assert.equal(frames.length, 2);
		// Nothing is left pending for the slower timer.
		await wait(60);
		assert.equal(frames.length, 2);
		s.stop();
	});

	it("paints at once when the last frame is old, and still honors output pressure", async () => {
		const { s, frames, terminal } = scheduler();
		s.paintNow();
		await wait(15);
		s.requestInteractive();
		await wait(3);
		assert.equal(frames.length, 2);
		(terminal as { pendingOutputBytes: number }).pendingOutputBytes = 10 * 1024 * 1024;
		await wait(15);
		s.requestInteractive();
		await wait(30);
		assert.equal(frames.length, 2);
		(terminal as { pendingOutputBytes: number }).pendingOutputBytes = 0;
		await wait(80);
		assert.equal(frames.length, 3);
		s.stop();
	});
});
