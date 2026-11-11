import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportQueue } from "../../src/octocode/subagents/handoff.ts";
import type { Report } from "../../src/octocode/subagents/handoff/pending.ts";
import { fakeHost } from "./fake-host.ts";

const report = (id: string): Report => ({
	reportId: `r-${id}`,
	content: `report of ${id}`,
	details: { id, status: "done", summary: "Done" },
	wake: true,
});

/** A queue with the real 1.5 s window whose running background children are `running`. */
function queueWith(running: Set<string>) {
	const f = fakeHost();
	const queue = new ReportQueue(f.api, undefined, () => running);
	queue.start({ getSessionFile: () => undefined, getEntries: () => [] });
	return { f, queue };
}

describe("background report batching", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("sends a report at once when no other background child is running", async () => {
		// The reporting child counts as running until its report is queued.
		const running = new Set(["a"]);
		const { f, queue } = queueWith(running);
		queue.add(report("a"));
		await vi.advanceTimersByTimeAsync(0);
		expect(f.sent.map(({ message }) => message.content)).toEqual(["report of a"]);
		expect(f.sent[0].options.triggerTurn).toBe(true);
		queue.persist();
	});

	it("holds a report while a sibling still runs, and sends both once that sibling reports", async () => {
		const running = new Set(["a", "b", "c"]);
		const { f, queue } = queueWith(running);
		queue.add(report("a"));
		await vi.advanceTimersByTimeAsync(500);
		expect(f.sent).toEqual([]);
		// `c` ended and left before `b` reported: only `b` is still to come.
		running.delete("c");
		queue.add(report("b"));
		await vi.advanceTimersByTimeAsync(0);
		expect(f.sent.map(({ message }) => message.content)).toEqual(["report of a", "report of b"]);
		// One wake for the batch: only the last send starts a turn.
		expect(f.sent.map(({ options }) => options.triggerTurn)).toEqual([false, true]);
		queue.persist();
	});

	it("keeps the whole window while a sibling runs without reporting", async () => {
		const running = new Set(["a", "b"]);
		const { f, queue } = queueWith(running);
		queue.add(report("a"));
		await vi.advanceTimersByTimeAsync(1_499);
		expect(f.sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(f.sent.map(({ message }) => message.content)).toEqual(["report of a"]);
		queue.persist();
	});

	it("keeps reports added in one pass together when nothing else runs", async () => {
		const { f, queue } = queueWith(new Set());
		queue.add(report("x"));
		queue.add(report("y"));
		await vi.advanceTimersByTimeAsync(0);
		expect(f.sent.map(({ options }) => options.triggerTurn)).toEqual([false, true]);
		queue.persist();
	});
});
