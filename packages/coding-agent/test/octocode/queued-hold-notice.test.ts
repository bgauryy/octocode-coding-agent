import { afterEach, describe, expect, it, vi } from "vitest";
import { ChainQueue } from "../../src/octocode/subagents/chain.ts";
import { GraphWake } from "../../src/octocode/subagents/graph-wake.ts";
import { PrerequisiteGate, parsePrerequisite } from "../../src/octocode/subagents/prerequisites.ts";
import { queueChild } from "../../src/octocode/subagents/queued-start.ts";
import { WAKE_INTERVAL_MS, WakePace } from "../../src/octocode/team/wake-pace.ts";

afterEach(() => vi.useRealTimers());

/** A queued child waiting on item B12 that is closed without completion, so the child is held. */
function setup() {
	let poke: (() => void) | undefined;
	let standing: "open" | "closed" = "open";
	const gate = new PrerequisiteGate({
		item: () => standing,
		lifecycle: () => () => undefined,
		follow: (next) => {
			poke = next;
			return () => undefined;
		},
	});
	const chain = new ChainQueue(gate, () => undefined);
	const sent: string[] = [];
	// The pace is spent: every notice waits for the retry.
	const pace = new WakePace();
	pace.record();
	const graph = new GraphWake(
		(content) => sent.push(content),
		() => true,
		pace,
	);
	const queued = queueChild(
		chain,
		(notice, about) => graph.tell(notice, about),
		(about) => graph.retract(about),
		{
			id: "kelp",
			role: "general",
			goal: "g",
			after: [parsePrerequisite("B12")!],
			prepare: () => undefined,
			onHeld: () => undefined,
		},
	);
	return {
		chain,
		queued,
		sent,
		graph,
		close: () => {
			standing = "closed";
			poke?.();
		},
	};
}

const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("held notice of a queued child", () => {
	it("is dropped when the child is resumed before the pace sends it", async () => {
		vi.useFakeTimers();
		const s = setup();
		const started = s.queued.wait(new AbortController().signal);
		s.close();
		await flush();
		expect(s.chain.get("kelp")?.held).toBeDefined();
		expect(s.sent).toEqual([]);
		expect(s.chain.start("kelp")).toBeUndefined();
		await started;
		await vi.advanceTimersByTimeAsync(WAKE_INTERVAL_MS * 2);
		expect(s.sent).toEqual([]);
		s.graph.stop();
	});

	it("is still sent while the child stays held", async () => {
		vi.useFakeTimers();
		const s = setup();
		void s.queued.wait(new AbortController().signal).catch(() => undefined);
		s.close();
		await flush();
		await vi.advanceTimersByTimeAsync(WAKE_INTERVAL_MS * 2);
		expect(s.sent.join("\n")).toContain("kelp");
		s.graph.stop();
	});
});
