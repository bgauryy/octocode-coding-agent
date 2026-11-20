import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import type { Terminal } from "../src/terminal.ts";
import { animationClock } from "../src/tokens/clock.ts";
import { FENCE_PROBE, FENCE_REPLY } from "../src/tui/latency-fence.ts";
import { RenderScheduler } from "../src/tui/render-scheduler.ts";
import { TerminalQueries } from "../src/tui/terminal-queries.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string): Promise<void> {
	for (const start = Date.now(); !condition(); await wait(2)) {
		if (Date.now() - start > 2000) assert.fail(`timed out waiting for ${what}`);
	}
}

/** Small constants so the tests run in tens of milliseconds; the ratios follow the shipped ones. */
const FAST = { probeIntervalMs: 20, behindAfterMs: 40, recoverBelowMs: 10, unsupportedAfterMs: 150 };

const started: RenderScheduler[] = [];
afterEach(() => {
	for (const s of started.splice(0)) s.stop();
});

function fenced(options: { interactive?: boolean } = {}) {
	const frames: number[] = [];
	const writes: string[] = [];
	const terminal = {
		pendingOutputBytes: 0,
		inputDraining: false,
		write: (data: string) => void writes.push(data),
	};
	const s = new RenderScheduler({
		terminal: () => terminal as unknown as Terminal,
		isStopped: () => false,
		paint: () => void frames.push(performance.now()),
		interactive: () => options.interactive ?? true,
		fenceConstants: FAST,
	});
	s.setPacing({ metrics: true });
	s.start();
	started.push(s);
	const probes = () => writes.filter((w) => w === FENCE_PROBE).length;
	let replies = 0;
	/** Answer the oldest unanswered probe, as a terminal does, and count it. */
	const reply = () => {
		replies++;
		s.fenceReply();
	};
	return { s, frames, writes, probes, terminal, reply, replies: () => replies };
}

/** Answer the probe that `paint` caused after `ms`. */
async function answerAfter(f: ReturnType<typeof fenced>, ms: number): Promise<void> {
	const n = f.probes();
	f.s.paintNow();
	await until(() => f.probes() === n + 1, "a probe");
	await wait(ms);
	f.reply();
}

/** A fast first reply sets the terminal's floor; a later probe aged past the threshold makes the scheduler behind. */
async function becomeBehind(f: ReturnType<typeof fenced>): Promise<void> {
	await answerAfter(f, 0);
	await answerAfter(f, FAST.behindAfterMs + 20);
}

describe("latency fence probe", () => {
	it("writes nothing while the screen is idle", async () => {
		const f = fenced();
		await wait(100);
		assert.deepEqual(f.writes, []);
	});

	it("probes after a frame, one at a time, no more often than the probe interval", async () => {
		const f = fenced();
		f.s.paintNow();
		assert.equal(f.probes(), 1);
		f.s.paintNow();
		f.s.paintNow();
		assert.equal(f.probes(), 1, "one probe outstanding");
		f.s.fenceReply();
		assert.equal(f.probes(), 1, "the next probe waits out the interval");
		await until(() => f.probes() === 2, "the second probe");
		f.s.fenceReply();
		await wait(FAST.probeIntervalMs * 2);
		assert.equal(f.probes(), 2, "no frame since: no probe");
	});

	it("does not probe off a TTY", async () => {
		const f = fenced({ interactive: false });
		f.s.paintNow();
		await wait(50);
		assert.deepEqual(f.writes, []);
	});

	it("does not probe when switched off", async () => {
		const f = fenced();
		f.s.setPacing({ latencyFence: false });
		f.s.paintNow();
		assert.deepEqual(f.writes, []);
	});

	it("does not probe once the scheduler stopped", () => {
		const f = fenced();
		f.s.stop();
		f.s.paintNow();
		assert.deepEqual(f.writes, []);
	});

	it("stops probing for good when the first probe is never answered, and frames behave as before", async () => {
		const f = fenced();
		f.s.paintNow();
		await wait(FAST.unsupportedAfterMs + 40);
		f.s.paintNow();
		await wait(FAST.probeIntervalMs * 3);
		assert.equal(f.probes(), 1);
		const before = f.frames.length;
		f.s.request();
		f.s.request();
		await until(() => f.frames.length === before + 1, "a streaming frame");
	});
});

describe("latency fence pacing", () => {
	it("holds streaming frames while behind and releases one per reply", async () => {
		const f = fenced();
		await becomeBehind(f);
		const base = f.frames.length;
		f.s.request();
		await until(() => f.frames.length === base + 1, "the first released frame");
		// That frame sent a probe; the next streaming frame waits for its reply.
		f.s.request();
		await wait(120);
		assert.equal(f.frames.length, base + 1, "held with a probe in flight");
		assert.equal(f.s.getStats().fence?.heldFrames ? 1 : 0, 1);
		f.s.fenceReply();
		await until(() => f.frames.length === base + 2, "the second released frame");
		f.s.request();
		await wait(60);
		assert.equal(f.frames.length, base + 2, "one frame per reply");
	});

	it("lets keyboard frames through while behind", async () => {
		const f = fenced();
		await becomeBehind(f);
		const base = f.frames.length;
		f.s.request(); // consumes the credit
		await until(() => f.frames.length === base + 1, "the credited frame");
		f.s.requestImmediate();
		await until(() => f.frames.length === base + 2, "a keyboard frame");
		f.s.requestImmediate();
		await until(() => f.frames.length === base + 3, "another keyboard frame");
	});

	it("goes back to normal when a reply arrives fast", async () => {
		const f = fenced();
		await becomeBehind(f);
		const n = f.probes();
		f.s.request();
		await until(() => f.probes() === n + 1, "the next probe");
		f.s.fenceReply(); // answered at once: RTT below the recovery bound
		const base = f.frames.length;
		f.s.request();
		await until(() => f.frames.length === base + 1, "a frame");
		f.s.request();
		await until(() => f.frames.length === base + 2, "another frame without a reply in between");
	});

	it("reports round trips and held frames when metrics are on", async () => {
		const f = fenced();
		await becomeBehind(f);
		const fence = f.s.getStats().fence;
		assert.ok(fence);
		assert.ok(fence.lastRttMs >= FAST.behindAfterMs);
		assert.ok(fence.maxRttMs >= fence.lastRttMs);
		assert.equal(fence.behind, true);
	});

	it("holds decoration while behind", async () => {
		const f = fenced();
		let ticks = 0;
		const stop = animationClock.subscribe(() => ticks++, { everyMs: 5, kind: "decor" });
		try {
			await becomeBehind(f);
			await wait(20);
			const after = ticks;
			await wait(80);
			assert.equal(ticks, after, "no decor ticks while behind");
		} finally {
			stop();
		}
	});

	it("keeps probing while behind with no frames, so a recovered terminal releases held decoration", async () => {
		const f = fenced();
		await becomeBehind(f);
		// No frame follows: decoration is held, so only the fence itself can notice that the terminal caught up. Its
		// timer may send that probe as becomeBehind's last reply lands, so wait for the first unanswered one.
		await until(() => f.probes() > f.replies(), "a probe while behind without frames");
		f.reply(); // answered at once
		assert.equal(f.s.getStats().fence?.behind, false);
	});
});

describe("latency fence on any link", () => {
	it("measures lag above the link's own floor: a steady slow link (SSH) is never behind", async () => {
		const f = fenced();
		const slow = FAST.behindAfterMs + 30;
		await answerAfter(f, slow);
		await answerAfter(f, slow);
		assert.equal(f.s.getStats().fence?.behind, false);
		const base = f.frames.length;
		f.s.request();
		await until(() => f.frames.length === base + 1, "a frame");
		f.s.request();
		await until(() => f.frames.length === base + 2, "another frame without a reply in between");
	});

	it("still counts lag that grows past the slow link's floor", async () => {
		const f = fenced();
		const slow = FAST.behindAfterMs + 10;
		// Still answered inside `unsupportedAfterMs`, so the reply is measured instead of the probe counted lost.
		await answerAfter(f, slow);
		await answerAfter(f, slow + FAST.behindAfterMs + 20);
		assert.equal(f.s.getStats().fence?.behind, true);
	});

	it("matches a late reply to the probe it answers, so a stalled terminal does not lower the floor", async () => {
		const f = fenced();
		await answerAfter(f, 0); // floor ~0
		f.s.paintNow();
		await until(() => f.probes() === 2, "a probe");
		await wait(FAST.unsupportedAfterMs + 20); // lost: the stalled terminal has not answered
		f.s.paintNow();
		await until(() => f.probes() === 3, "the probe after the lost one");
		f.s.fenceReply(); // the late answer to probe 2, not to probe 3
		const fence = f.s.getStats().fence;
		assert.ok((fence?.lastRttMs ?? 0) >= FAST.unsupportedAfterMs, `measured from probe 2: ${fence?.lastRttMs}`);
		assert.equal(fence?.behind, true);
	});

	it("lets the floor rise when the link itself got slower, measured over recent replies", async () => {
		const f = fenced();
		await answerAfter(f, 0);
		const slow = FAST.behindAfterMs + 20;
		for (let i = 0; i < 41; i++) await answerAfter(f, slow);
		assert.ok((f.s.getStats().fence?.floorMs ?? 0) >= slow - 5);
		await answerAfter(f, slow);
		assert.equal(f.s.getStats().fence?.behind, false);
	});

	it("sends no probe while the terminal drains input before exit, so no reply reaches the shell", async () => {
		const f = fenced();
		f.terminal.inputDraining = true;
		f.s.paintNow();
		await wait(FAST.probeIntervalMs * 2);
		assert.equal(f.probes(), 0);
	});
});

describe("fence reply routing", () => {
	function queries(onFenceReply: () => void) {
		return new TerminalQueries({
			terminal: () => ({ write() {} }) as unknown as Terminal,
			isStopped: () => false,
			onCellSizeChanged() {},
			onFenceReply,
		});
	}

	it("consumes a reply, also when no fence waits for it", () => {
		let replies = 0;
		const q = queries(() => replies++);
		assert.equal(q.consumeReply(FENCE_REPLY), true);
		assert.equal(replies, 1);
		assert.equal(q.consumeReply("\x1b[0m"), false);
		assert.equal(q.consumeReply("n"), false);
	});

	it("is delivered by the stdin splitter as one sequence", () => {
		const buffer = new StdinBuffer();
		const seen: string[] = [];
		buffer.on("data", (s: string) => seen.push(s));
		buffer.process(`a${FENCE_REPLY}b`);
		assert.deepEqual(seen, ["a", FENCE_REPLY, "b"]);
		buffer.destroy();
	});

	it("a late reply after the scheduler stopped is consumed and changes nothing", async () => {
		const f = fenced();
		f.s.paintNow();
		f.s.stop();
		const q = queries(() => f.s.fenceReply());
		assert.equal(q.consumeReply(FENCE_REPLY), true);
		assert.equal(f.s.getStats().fence?.behind ?? false, false);
	});
});
