import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportQueue } from "../../src/octocode/subagents/handoff.ts";
import type { Report } from "../../src/octocode/subagents/handoff/pending.ts";
import { heldReports, ReportGroups } from "../../src/octocode/subagents/report-groups.ts";
import { fakeHost } from "./fake-host.ts";

const report = (id: string): Report => ({
	reportId: `r-${id}`,
	content: `report of ${id}`,
	details: { id, status: "done", summary: "Done" },
	wake: true,
});

describe("ReportGroups", () => {
	const started = (ids: string[], background = true) => {
		const groups = new ReportGroups();
		const alive = new Map(ids.map((id) => [id, true]));
		for (const id of ids) {
			groups.join(id, background);
			groups.working(id, () => alive.get(id) === true);
		}
		return { groups, alive };
	};

	it("sends a finished child's report at once while its siblings still work: a finished result never waits for slower ones", () => {
		const { groups } = started(["a", "b", "c"]);
		groups.settled("a");
		groups.leave("a");
		expect(heldReports(groups, ["a"])).toEqual(new Set());
	});

	it("holds a report while a sibling of its step settled and builds its report, until that sibling's run ends", () => {
		const { groups } = started(["a", "b", "c"]);
		groups.settled("b");
		groups.settled("a");
		groups.leave("a");
		expect(heldReports(groups, ["a"])).toEqual(new Set(["a"]));
		// Both reports queued: they go together.
		expect(heldReports(groups, ["a", "b"])).toEqual(new Set());
		groups.leave("b");
		expect(heldReports(groups, ["a"])).toEqual(new Set());
	});

	it("never holds for a foreground sibling, nor for a sibling of another step", () => {
		const { groups } = started(["a"]);
		groups.join("f", false);
		groups.working("f", () => true);
		groups.settled("f");
		groups.nextStep();
		groups.join("later", true);
		groups.working("later", () => true);
		groups.settled("later");
		groups.settled("a");
		expect(heldReports(groups, ["a"])).toEqual(new Set());
	});

	it("sends every report when the hold itself throws", () => {
		const f = fakeHost();
		const queue = new ReportQueue(f.api, () => {
			throw new Error("gone");
		});
		queue.start({ getSessionFile: () => undefined, getEntries: () => [] });
		vi.useFakeTimers();
		try {
			queue.add(report("a"));
			vi.advanceTimersByTime(1);
			expect(f.sent).toHaveLength(1);
		} finally {
			queue.persist();
			vi.useRealTimers();
		}
	});

	it("holds a report only for a report being built in its own step, and sends the others without the held ones", async () => {
		const groups = new ReportGroups();
		for (const id of ["a", "b"]) groups.join(id, true);
		groups.nextStep();
		groups.join("lone", true);
		// `b` settled and builds its report; `a`'s report waits for it, the lone child's of another step does not.
		groups.settled("a");
		groups.settled("b");
		const f = fakeHost();
		const queue = new ReportQueue(f.api, (queued) => heldReports(groups, queued));
		queue.start({ getSessionFile: () => undefined, getEntries: () => [] });
		vi.useFakeTimers();
		try {
			queue.add(report("a"));
			groups.leave("a");
			queue.add(report("lone"));
			groups.leave("lone");
			await vi.advanceTimersByTimeAsync(0);
			expect(f.sent.map(({ message }) => (message as Report).details.id)).toEqual(["lone"]);
			queue.add(report("b"));
			groups.leave("b");
			queue.reportingChanged();
			await vi.advanceTimersByTimeAsync(0);
			expect(f.sent.map(({ message }) => (message as Report).details.id)).toEqual(["lone", "a", "b"]);
			expect(f.sent.map(({ options }) => (options as { triggerTurn: boolean }).triggerTurn)).toEqual([
				true,
				false,
				true,
			]);
		} finally {
			queue.persist();
			vi.useRealTimers();
		}
	});

	it("waits for a settled sibling's report only while its build is alive: a stall or its run's end releases", () => {
		const groups = new ReportGroups();
		let building: boolean | "throws" = true;
		groups.join("a", true);
		groups.join("b", true);
		groups.working("a", () => true);
		groups.working("b", () => {
			if (building === "throws") throw new Error("gone");
			return building;
		});
		groups.settled("a");
		groups.settled("b");
		expect(groups.awaitsReport("a", new Set(["a"]))).toBe(true);
		// The sibling stalled while it left, or its supervised run is over with the report not yet queued.
		building = false;
		expect(groups.awaitsReport("a", new Set(["a"]))).toBe(false);
		building = "throws";
		expect(groups.awaitsReport("a", new Set(["a"]))).toBe(false);
	});

	it("retries a rejected send under the same hold: it never takes a held sibling's report along", async () => {
		for (const exhausted of [false, true]) {
			const groups = new ReportGroups();
			for (const id of ["a", "b", "c"]) {
				groups.join(id, true);
				groups.working(id, () => true);
			}
			const f = fakeHost();
			const send = f.api.session.sendMessage;
			let rejecting = true;
			f.api.session.sendMessage = (...args: Parameters<typeof send>) => {
				send(...args);
				const id = (args[0].details as { id: string }).id;
				return rejecting && id === "a" ? Promise.reject(new Error("busy")) : undefined;
			};
			const queue = new ReportQueue(f.api, (queued) => heldReports(groups, queued));
			// The parent is in a turn: only a sibling's report being built holds one.
			queue.start({ getSessionFile: () => undefined, getEntries: () => [] }, () => false);
			vi.useFakeTimers();
			try {
				const ids = () => f.sent.map(({ message }) => (message as Report).details.id);
				// `a` ended before its siblings settled: it goes alone, and its send is rejected.
				groups.settled("a");
				queue.add(report("a"));
				groups.leave("a");
				await vi.advanceTimersByTimeAsync(0);
				expect(ids()).toEqual(["a"]);
				// Every timed retry is rejected too, or only the first one.
				if (exhausted) await vi.advanceTimersByTimeAsync(8 * 60_000);
				else rejecting = false;
				const tries = f.sent.length;
				// Now `c` settled and builds its report: `b`'s report waits for it.
				groups.settled("c");
				groups.settled("b");
				queue.add(report("b"));
				groups.leave("b");
				rejecting = false;
				if (exhausted) queue.retryExhausted();
				else await vi.advanceTimersByTimeAsync(1_000);
				expect(
					ids()
						.slice(tries)
						.filter((id) => id === "b"),
				).toEqual([]);
				queue.add(report("c"));
				groups.leave("c");
				queue.reportingChanged();
				await vi.advanceTimersByTimeAsync(0);
				expect(ids().slice(tries).sort()).toEqual(["a", "b", "c"]);
			} finally {
				queue.persist();
				vi.useRealTimers();
			}
		}
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

type Fate = "settles" | "stalls" | "crashes" | "foreground";

interface Child {
	id: string;
	step: number;
	fate: Fate;
	/** When it settles, stops working (stall, crash) or, in the foreground, ends. */
	end: number;
	/** When its report is queued and its run ends (a background child). */
	queued: number;
}

describe("group report batching over random steps, children, stalls, crashes and parent turns", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	for (let seed = 1; seed <= 24; seed++) {
		it(`delivers once, keeps each step's order, waits only while it should (seed ${seed})`, async () => {
			const next = random(seed);
			const calm = seed % 3 === 0;
			const steps = 1 + Math.floor(next() * 3);
			const times = new Set<number>();
			const pick = (from = 1) => {
				for (;;) {
					const t = from + 1 + Math.floor(next() * 2_000);
					if (!times.has(t)) {
						times.add(t);
						return t;
					}
				}
			};
			const children: Child[] = [];
			for (let step = 0; step < steps; step++) {
				for (let count = 1 + Math.floor(next() * 4); count > 0; count--) {
					const roll = next();
					const fate: Fate =
						calm || roll < 0.6 ? "settles" : roll < 0.75 ? "stalls" : roll < 0.9 ? "crashes" : "foreground";
					const end = pick();
					children.push({ id: `s${step}c${children.length}`, step, fate, end, queued: pick(end) });
				}
			}
			const busy = calm ? undefined : next() < 0.5 ? { from: pick(), ms: 1 + Math.floor(next() * 500) } : undefined;

			const groups = new ReportGroups();
			const working = new Map<string, boolean>();
			/** Settled with its answer: its report is being built until it is queued. */
			const settled = new Set<string>();
			/** Its run ended: a background child's report is queued; a foreground one is over. */
			const ended = new Set<string>();
			let idle = true;
			const f = fakeHost();
			const queue = new ReportQueue(f.api, (queued) => heldReports(groups, queued));
			queue.start({ getSessionFile: () => undefined, getEntries: () => [] }, () => idle);
			for (let step = 0; step < steps; step++) {
				if (step > 0) groups.nextStep();
				for (const child of children.filter((each) => each.step === step)) {
					groups.join(child.id, child.fate !== "foreground");
					working.set(child.id, true);
					groups.working(child.id, () => working.get(child.id) === true);
				}
			}

			/**
			 * The documented policy (native-features, Delivery), from the test's own state: a finished child's report goes at
			 * once unless a background sibling of its step already finished and is still assembling its report (settled, its
			 * run not over). Whether the parent is in a turn does not matter.
			 */
			const shouldWait = (id: string): boolean => {
				const own = children.find((child) => child.id === id)!;
				return children.some(
					(child) =>
						child.step === own.step &&
						child.id !== id &&
						child.fate !== "foreground" &&
						settled.has(child.id) &&
						!ended.has(child.id),
				);
			};

			const sent: Array<{ id: string; at: number; wake: boolean }> = [];
			const send = f.api.session.sendMessage;
			f.api.session.sendMessage = (...args: Parameters<typeof send>) => {
				const id = (args[0].details as { id: string }).id;
				// Nothing goes that should still wait.
				expect(shouldWait(id), `${id} sent at ${Date.now()}`).toBe(false);
				sent.push({ id, at: Date.now(), wake: (args[1] as { triggerTurn: boolean }).triggerTurn });
				return send(...args);
			};
			const added: string[] = [];
			for (const child of children) {
				setTimeout(() => {
					if (child.fate === "settles") {
						settled.add(child.id);
						groups.settled(child.id);
					} else if (child.fate === "foreground") {
						ended.add(child.id);
						groups.leave(child.id);
						queue.reportingChanged();
					} else {
						working.set(child.id, false);
						queue.reportingChanged();
					}
				}, child.end);
				if (child.fate === "foreground") continue;
				setTimeout(() => {
					added.push(child.id);
					queue.add(report(child.id));
					ended.add(child.id);
					groups.leave(child.id);
					queue.reportingChanged();
				}, child.queued);
			}
			if (busy) {
				setTimeout(() => {
					idle = false;
					queue.reportingChanged();
				}, busy.from);
				setTimeout(() => (idle = true), busy.from + busy.ms);
			}

			const events = new Set([
				...children.flatMap((child) => [child.end, child.queued]),
				...(busy ? [busy.from, busy.from + busy.ms] : []),
			]);
			const last = Math.max(...events);
			const start = Date.now();
			for (let t = 1; t <= last + 3; t++) {
				await vi.advanceTimersByTimeAsync(1);
				// Right after an event the queue's own timer turn may still be due; one millisecond later nothing may wait
				// that should not.
				if (events.has(t) || events.has(t - 1)) continue;
				for (const id of added.filter((each) => !sent.some((entry) => entry.id === each)))
					expect(shouldWait(id), `${id} waits at ${t}`).toBe(true);
			}
			// Each report once; within a step, in the order the reports were queued.
			expect(sent.map((entry) => entry.id).sort()).toEqual([...added].sort());
			for (let step = 0; step < steps; step++) {
				const ofStep = (ids: string[]) => ids.filter((id) => children.find((child) => child.id === id)!.step === step);
				expect(ofStep(sent.map((entry) => entry.id))).toEqual(ofStep(added));
			}
			if (calm) {
				// With the parent idle, reports that went together (a sibling's report was being assembled) are one batch,
				// whose last send alone wakes the parent; a report that waited for nobody is a batch of its own.
				const batches = new Set(sent.map((entry) => entry.at));
				expect(sent.filter((entry) => entry.wake)).toHaveLength(batches.size);
			}
			expect(Date.now() - start).toBeGreaterThan(0);
			queue.persist();
		});
	}
});
