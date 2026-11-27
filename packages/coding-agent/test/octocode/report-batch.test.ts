import { withoutSourceHeader } from "../../src/octocode/shared/fence.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportQueue } from "../../src/octocode/subagents/handoff.ts";
import { heldReports, ReportGroups } from "../../src/octocode/subagents/report-groups.ts";
import type { Report } from "../../src/octocode/subagents/handoff/pending.ts";
import { fakeHost } from "./fake-host.ts";

const report = (id: string): Report => ({
	reportId: `r-${id}`,
	content: `report of ${id}`,
	details: { id, status: "done", summary: "Done" },
	wake: true,
});

/**
 * Background children started in one parent step: `add` settles one (its report is now in flight), `delete` ends its run
 * (its report queued, or none). None has a probe, so only a report in flight holds a sibling's.
 */
class Step {
	readonly groups = new ReportGroups();
	constructor(...ids: string[]) {
		for (const id of ids) this.groups.join(id, true);
	}
	add(id: string): void {
		this.groups.settled(id);
	}
	delete(id: string): void {
		this.groups.leave(id);
	}
}

/** A queue whose children all belong to `reporting`'s step. */
function queueWith(reporting: Step) {
	const f = fakeHost();
	const at: number[] = [];
	const send = f.api.session.sendMessage;
	f.api.session.sendMessage = (...args: Parameters<typeof send>) => {
		at.push(Date.now());
		return send(...args);
	};
	const queue = new ReportQueue(f.api, (queued) => heldReports(reporting.groups, queued));
	queue.start({ getSessionFile: () => undefined, getEntries: () => [] });
	return { f, queue, at };
}

const contents = (f: ReturnType<typeof fakeHost>) =>
	f.sent.map(({ message }) => withoutSourceHeader((message as Report).content));
const wakes = (f: ReturnType<typeof fakeHost>) =>
	f.sent.map(({ options }) => (options as { triggerTurn: boolean }).triggerTurn);

describe("background report batching", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("sends a report at the end of its tick when no sibling's report is in flight, however many still work", async () => {
		const { f, queue } = queueWith(new Step("a"));
		queue.add(report("a"));
		expect(f.sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(0);
		expect(contents(f)).toEqual(["report of a"]);
		expect(wakes(f)).toEqual([true]);
		queue.persist();
	});

	it("holds a report while a sibling's report is in flight, and sends both as one wake once it is queued", async () => {
		const reporting = new Step("a", "b");
		reporting.add("a");
		reporting.add("b");
		const { f, queue } = queueWith(reporting);
		queue.add(report("a"));
		reporting.delete("a");
		queue.reportingChanged();
		await vi.advanceTimersByTimeAsync(60_000);
		// No timer gives up on `b`: its report is still being built.
		expect(f.sent).toEqual([]);
		queue.add(report("b"));
		reporting.delete("b");
		queue.reportingChanged();
		await vi.advanceTimersByTimeAsync(0);
		expect(contents(f)).toEqual(["report of a", "report of b"]);
		expect(wakes(f)).toEqual([false, true]);
		queue.persist();
	});

	it("sends the held batch when the sibling's run ends without a report (it crashed after settling)", async () => {
		const reporting = new Step("a", "b");
		reporting.add("a");
		reporting.add("b");
		const { f, queue } = queueWith(reporting);
		queue.add(report("a"));
		reporting.delete("a");
		await vi.advanceTimersByTimeAsync(0);
		expect(f.sent).toEqual([]);
		reporting.delete("b");
		queue.reportingChanged();
		await vi.advanceTimersByTimeAsync(0);
		expect(contents(f)).toEqual(["report of a"]);
		expect(wakes(f)).toEqual([true]);
		queue.persist();
	});

	it("lets a sibling that settles before the end of the tick join the batch", async () => {
		const reporting = new Step("a", "b");
		const { f, queue } = queueWith(reporting);
		queue.add(report("a"));
		reporting.add("b");
		await vi.advanceTimersByTimeAsync(0);
		expect(f.sent).toEqual([]);
		queue.add(report("b"));
		reporting.delete("b");
		queue.reportingChanged();
		await vi.advanceTimersByTimeAsync(0);
		expect(wakes(f)).toEqual([false, true]);
		queue.persist();
	});

	it("asks for a turn with every send of a waking batch while the parent is busy, so it drains them as one", async () => {
		const f = fakeHost();
		const queue = new ReportQueue(f.api);
		queue.start({ getSessionFile: () => undefined, getEntries: () => [] }, () => false);
		queue.add(report("a"));
		queue.add(report("b"));
		await vi.advanceTimersByTimeAsync(0);
		expect(f.sent.map(({ options }) => options)).toEqual([
			{ triggerTurn: true, deliverAs: "followUp", together: true },
			{ triggerTurn: true, deliverAs: "followUp", together: true },
		]);
		queue.persist();
	});

	it("keeps reports added in one pass together", async () => {
		const { f, queue } = queueWith(new Step("x", "y"));
		queue.add(report("x"));
		queue.add(report("y"));
		await vi.advanceTimersByTimeAsync(0);
		expect(wakes(f)).toEqual([false, true]);
		queue.persist();
	});

	it("does not hold anything when what is in flight cannot be read", async () => {
		const f = fakeHost();
		const queue = new ReportQueue(f.api, () => {
			throw new Error("runs unreadable");
		});
		queue.start({ getSessionFile: () => undefined, getEntries: () => [] });
		queue.add(report("a"));
		await vi.advanceTimersByTimeAsync(0);
		expect(contents(f)).toEqual(["report of a"]);
		queue.persist();
	});
});

/** A small seeded generator, so a failing case can be replayed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("background report batching over random finishing times", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
		it(`delivers each report once, in completion order, one wake per overlapping group, at once (seed ${seed})`, async () => {
			const next = random(seed);
			const n = 1 + Math.floor(next() * 8);
			// Distinct whole milliseconds: a child settles at `settle` and its report is queued at `queued`.
			const times = new Set<number>();
			const pick = () => {
				for (;;) {
					const t = 1 + Math.floor(next() * 3_000);
					if (!times.has(t)) {
						times.add(t);
						return t;
					}
				}
			};
			const children = Array.from({ length: n }, (_, i) => {
				const a = pick();
				const b = pick();
				// Some reports are crashes of a child that never settled: queued with nothing in flight before.
				const crashed = next() < 0.2;
				return { id: `c${i}`, settle: crashed ? undefined : Math.min(a, b), queued: Math.max(a, b) };
			});
			const reporting = new Step(...children.map((child) => child.id));
			const start = Date.now();
			const { f, queue, at } = queueWith(reporting);
			for (const child of children) {
				if (child.settle !== undefined) setTimeout(() => reporting.add(child.id), child.settle);
				setTimeout(() => {
					queue.add(report(child.id));
					reporting.delete(child.id);
					queue.reportingChanged();
				}, child.queued);
			}
			await vi.advanceTimersByTimeAsync(3_100);
			// Groups: reports whose in-flight spans overlap, chained; a report is in flight from its settle to its queueing.
			const spans = children
				.map((child) => ({ id: child.id, from: child.settle ?? child.queued, to: child.queued }))
				.sort((a, b) => a.from - b.from);
			const groups: Array<{ ids: string[]; end: number }> = [];
			for (const span of spans) {
				const last = groups.at(-1);
				if (last && span.from <= last.end) {
					last.ids.push(span.id);
					last.end = Math.max(last.end, span.to);
				} else groups.push({ ids: [span.id], end: span.to });
			}
			const byCompletion = [...children].sort((a, b) => a.queued - b.queued).map((child) => `report of ${child.id}`);
			expect(contents(f)).toEqual(byCompletion);
			expect(wakes(f).filter(Boolean)).toHaveLength(groups.length);
			// Nothing waits once its group is complete: each send follows its group's last report by one timer turn at most.
			for (const [index, sentAt] of at.entries()) {
				const id = (f.sent[index].message as Report).details.id;
				const group = groups.find((each) => each.ids.includes(id))!;
				expect(sentAt - start - group.end).toBeGreaterThanOrEqual(0);
				expect(sentAt - start - group.end).toBeLessThanOrEqual(1);
			}
			queue.persist();
		});
	}
});
