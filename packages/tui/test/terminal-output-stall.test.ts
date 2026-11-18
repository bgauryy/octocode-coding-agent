import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, describe, it, mock } from "node:test";
import { TerminalOutput } from "../src/terminal/output.ts";
import { ProgressIndicator } from "../src/terminal/progress.ts";
import { STALL_AFTER_MS } from "../src/terminal/stall-watch.ts";
import { TITLE_FRAME_MS, TitlePainter, type TitleState } from "../src/terminal/title-painter.ts";

/** A stdout whose terminal reads only when told to: writes queue until `drain()`, like a paused PTY. */
class FakeStdout extends EventEmitter {
	readonly isTTY = false;
	reading = false;
	readonly delivered: string[] = [];
	private queue: Array<{ chunk: string; callback?: (error?: Error | null) => void }> = [];

	get writableLength(): number {
		return this.queue.reduce((total, entry) => total + Buffer.byteLength(entry.chunk), 0);
	}

	write(chunk: string, callback?: (error?: Error | null) => void): boolean {
		if (this.reading && this.queue.length === 0) {
			this.delivered.push(chunk);
			if (callback) queueMicrotask(() => callback());
			return true;
		}
		this.queue.push({ chunk, callback });
		return false;
	}

	/** The terminal reads everything queued and keeps reading. */
	drain(): void {
		this.reading = true;
		const queue = this.queue;
		this.queue = [];
		for (const entry of queue) {
			this.delivered.push(entry.chunk);
			entry.callback?.();
		}
	}
}

const asStdout = (fake: FakeStdout) => fake as unknown as typeof process.stdout;
/** Run immediates queued so far: the watch checks a timed-out mark only after the I/O poll. */
const afterPoll = () => new Promise<void>((resolve) => setImmediate(resolve));
const count = (chunks: string[], needle: string) => chunks.filter((chunk) => chunk.includes(needle)).length;

describe("terminal stall diagnostic", () => {
	afterEach(() => mock.timers.reset());

	it("opens an episode when queued output waits 5 s and closes it when the terminal reads again", async () => {
		mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
		const stdout = new FakeStdout();
		const output = new TerminalOutput(asStdout(stdout));
		output.setFrameCap(64 * 1024);
		output.write("\x1b[?2004h");
		mock.timers.tick(STALL_AFTER_MS - 1);
		await afterPoll();
		assert.equal(output.getTelemetry().stalls, undefined, "not a stall before 5 s");
		assert.equal(output.allowsDecorativeOutput(), true);

		mock.timers.tick(1);
		await afterPoll();
		const open = output.getTelemetry().stalls;
		assert.equal(open?.episodes, 1);
		assert.equal(open?.recent[0]?.ongoing, true);
		assert.equal(open?.recent[0]?.startedAt, 1_000_000);
		assert.equal(output.allowsDecorativeOutput(), false, "decoration waits while stalled");

		for (let frame = 0; frame < 10; frame++) output.write("f".repeat(20_000), "frame");
		output.write("line\r\n");
		mock.timers.tick(2_000);
		stdout.drain();
		const closed = output.getTelemetry().stalls;
		assert.equal(closed?.episodes, 1);
		assert.equal(closed?.totalMs, STALL_AFTER_MS + 2_000);
		assert.deepEqual(closed?.recent, [
			{
				startedAt: 1_000_000,
				durationMs: STALL_AFTER_MS + 2_000,
				// Three frames fit under the 64 KiB cap; the other seven were dropped.
				peakQueuedBytes: "\x1b[?2004h".length + 3 * 20_000 + "line\r\n".length,
				droppedFrameBytes: 7 * 20_000,
				essentialBytes: "line\r\n".length,
				ongoing: false,
			},
		]);
		assert.equal(output.allowsDecorativeOutput(), true);
	});

	it("does not count an event loop that Octocode blocked: the drain is seen before the timeout check", async () => {
		mock.timers.enable({ apis: ["setTimeout", "Date"] });
		const stdout = new FakeStdout();
		const output = new TerminalOutput(asStdout(stdout));
		output.write("frame", "frame");
		// The timer and the write completion are both ready when the loop wakes; I/O is polled before immediates.
		mock.timers.tick(STALL_AFTER_MS * 3);
		stdout.drain();
		await afterPoll();
		assert.equal(output.getTelemetry().stalls, undefined);
	});

	it("does not count a slow terminal that keeps reading", async () => {
		mock.timers.enable({ apis: ["setTimeout", "Date"] });
		const stdout = new FakeStdout();
		const output = new TerminalOutput(asStdout(stdout));
		for (let second = 0; second < 30; second++) {
			stdout.reading = false;
			output.write("x".repeat(10_000), "frame");
			mock.timers.tick(STALL_AFTER_MS - 1_000);
			stdout.drain();
			await afterPoll();
		}
		assert.equal(output.getTelemetry().stalls, undefined);
	});

	it("queues only mode and scrollback bytes while stalled: title and progress wait and land once", async () => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		const stdout = new FakeStdout();
		const output = new TerminalOutput(asStdout(stdout));
		const accepts = () => output.allowsDecorativeOutput();
		let state: TitleState = "running";
		const title = new TitlePainter(
			{
				state: () => state,
				target: () => ({ cwd: "/repo", setTitle: (text) => output.write(`\x1b]0;${text}\x07`) }),
				description: () => "task",
				agents: () => 0,
			},
			{ full: (current, _description, _cwd, _agents, frame) => `${current}:${frame}`, plain: () => "plain" },
			accepts,
		);
		const progress = new ProgressIndicator(accepts, (sequence) => output.write(sequence), accepts);
		output.write("start");
		mock.timers.tick(STALL_AFTER_MS);
		await afterPoll();
		assert.equal(output.getTelemetry().stalls?.recent[0]?.ongoing, true);

		// One minute of a busy session against a terminal that reads nothing.
		let scrollback = 0;
		let modes = 0;
		title.paint();
		for (let second = 0; second < 60; second++) {
			progress.set(second % 2 === 0);
			state = second % 3 === 0 ? "thinking" : "running";
			title.paint();
			for (let frame = 0; frame < 60; frame++) output.write("f".repeat(4_000), "frame");
			const line = `output line ${second}\r\n`;
			output.write(line);
			scrollback += Buffer.byteLength(line);
			if (second % 20 === 0) {
				output.write("\x1b[?25l");
				modes += "\x1b[?25l".length;
			}
			mock.timers.tick(1_000);
		}
		const stall = output.getTelemetry().stalls?.recent[0];
		assert.equal(stall?.essentialBytes, scrollback + modes, "only scrollback and mode bytes grew the queue");
		assert.ok((stall?.droppedFrameBytes ?? 0) > 0, "frames were dropped");
		assert.ok((stall?.peakQueuedBytes ?? Infinity) <= 512 * 1024 + scrollback + modes + "start".length);
		assert.equal(count(stdout.delivered, "\x1b]0;"), 0);
		assert.equal(count(stdout.delivered, "\x1b]9;4;"), 0);

		stdout.drain();
		state = "done";
		progress.set(false);
		title.paint();
		mock.timers.tick(TITLE_FRAME_MS);
		assert.deepEqual(
			stdout.delivered.filter((chunk) => chunk.startsWith("\x1b]")),
			["\x1b]9;4;0\x07", "\x1b]0;done:0\x07"],
			"the latest progress and title, once each",
		);
		progress.clear();
		title.stop();
	});
});
