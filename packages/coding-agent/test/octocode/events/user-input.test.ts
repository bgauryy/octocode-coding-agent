import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveLoop } from "../../../src/octocode/events/loop/live.ts";
import type { Batch } from "../../../src/octocode/events/loop/types.ts";
import { makeSource, userSource } from "../../../src/octocode/events/source.ts";
import { wakeCatalog } from "../../../src/octocode/wake/loop-catalog.ts";
import type { PayloadEvent } from "../../../src/octocode/events/topics.ts";

const jobExit = (job: string): PayloadEvent => ({ kind: "job.exit", job, exit: 0, durationMs: 1, startedAt: 0 });

function rig() {
	const sent: Batch<string>[] = [];
	const live = new LiveLoop<string>({
		catalog: wakeCatalog,
		windowMs: () => 2000,
		send: (batch) => void sent.push(batch),
		failed: (error) => {
			throw error;
		},
	});
	const background = (carry: string) =>
		live.take({
			event: jobExit(carry),
			source: makeSource("job", carry, "in-process", "proven"),
			wake: true,
			priority: "regular",
			carry,
		});
	return { live, sent, background };
}

describe("user input through the live loop", () => {
	beforeEach(() => void vi.useFakeTimers());
	afterEach(() => void vi.useRealTimers());

	it("delivers terminal input at once, ahead of background events, carrying its source", () => {
		const { live, sent, background } = rig();
		background("job-1");
		live.input("hello", "typed", userSource("terminal"));
		expect(sent).toHaveLength(1);
		expect(sent[0].entries.map((entry) => entry.carry)).toEqual(["typed", "job-1"]);
		const [first] = sent[0].entries;
		expect(first?.type === "input" && first.source).toMatchObject({ kind: "terminal", channel: "terminal", trust: 4 });
		vi.advanceTimersByTime(10_000);
		expect(sent).toHaveLength(1);
	});

	it.each(["acp", "web"] as const)("never holds %s input in the coalescing window", (channel) => {
		const { live, sent, background } = rig();
		background("job-1");
		background("job-2");
		live.input("go", "typed", userSource(channel));
		expect(sent).toHaveLength(1);
		expect(sent[0].entries.map((entry) => entry.carry)).toEqual(["typed", "job-1", "job-2"]);
	});

	it("runs a Stop at once, while the window is open and while compaction holds the lock, dropping nothing", () => {
		const { live, sent, background } = rig();
		background("job-1");
		let stopped = 0;
		expect(live.preempt(() => ++stopped)).toBe(1);
		expect(live.queued().Q3).toBe(1);
		live.compactionStarted();
		expect(live.preempt(() => ++stopped)).toBe(2);
		expect(sent).toHaveLength(0);
		expect(live.queued().Q3).toBe(1);
	});

	it("gives user trust only to the terminal; acp and web carry less, others none", () => {
		expect(userSource("terminal").trust).toBe(4);
		expect(userSource("acp").trust).toBe(3);
		expect(userSource("web").trust).toBe(3);
		expect(userSource("rpc").trust).toBeLessThanOrEqual(1);
	});

	it("never lets a peer, child or external sender claim a user channel", () => {
		for (const kind of ["peer", "child", "external", "hook", "mcp", "webcontent"] as const)
			expect(makeSource(kind, "x", "terminal", "self-reported").trust).toBe(0);
		expect(makeSource("terminal", "x", "socket", "proven").trust).toBe(0);
		expect(makeSource("terminal", "x", "acp", "proven").trust).toBe(0);
		expect(makeSource("acp", "x", "terminal", "proven").trust).toBe(0);
		expect(makeSource("terminal", "x", "terminal", "self-reported").trust).toBe(0);
		expect(makeSource("peer", "x", "terminal", "proven").trust).toBeLessThan(4);
	});
});
