import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveLoop } from "../../../src/octocode/events/loop/live.ts";
import { EventLoop, type LoopOptions } from "../../../src/octocode/events/loop/loop.ts";
import { MemoryEventStore } from "../../../src/octocode/events/loop/store.ts";
import type { Batch, DeliveryPoint } from "../../../src/octocode/events/loop/types.ts";
import { makeSource } from "../../../src/octocode/events/source.ts";
import type { PayloadEvent } from "../../../src/octocode/events/topics.ts";
import { wakeCatalog } from "../../../src/octocode/wake/loop-catalog.ts";

const priorityOfEvent = wakeCatalog.priority;

/**
 * The delivery contract, told through what a host receives: which entries, in what order, at which point of a run, and
 * whether the batch asks for a turn. Nothing here reads a queue or a timer.
 */

const source = makeSource("child", "a", "in-process", "proven");
const job = (id: string): PayloadEvent => ({ kind: "job.exit", job: id, exit: 0, durationMs: 1, startedAt: 0 });
const mail = (id: number, interrupt: boolean): PayloadEvent => ({
	kind: "agent.message",
	from: "parent",
	id,
	replyRequired: false,
	interrupt,
});

interface Sent {
	carries: string[];
	point: DeliveryPoint;
	trigger: boolean;
}

const sentOf = (batch: Batch<string>, point: DeliveryPoint): Sent => ({
	carries: batch.entries.map((entry) => entry.carry),
	point,
	trigger: batch.trigger,
});

function loopRig(over: Partial<LoopOptions<string>> = {}) {
	const sent: Sent[] = [];
	const loop = new EventLoop<string>({
		catalog: wakeCatalog,
		store: new MemoryEventStore(),
		deliver: (batch, point) => void sent.push(sentOf(batch, point)),
		onError: (error) => {
			throw error;
		},
		...over,
	});
	const arrive = (event: PayloadEvent, carry: string) =>
		loop.notify({ event, source, wake: true, priority: priorityOfEvent(event), carry });
	return { loop, sent, arrive };
}

describe("the priority of an event", () => {
	it("is urgent only for a team message its sender marked interrupt", () => {
		expect(priorityOfEvent(mail(1, true))).toBe("urgent");
		expect(priorityOfEvent(mail(1, false))).toBe("regular");
		expect(priorityOfEvent(job("j"))).toBe("regular");
		expect(priorityOfEvent({ kind: "agent.report", agent: "a", role: "r", outcome: "done", reportId: "1" })).toBe(
			"regular",
		);
	});
});

describe("a regular event is the next task", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("joins a run at its next step, in arrival order, and is not delivered again when the run ends", () => {
		const { loop, sent, arrive } = loopRig({ windowMs: () => 2000 });
		loop.signal("run_start");
		arrive(job("j1"), "first");
		arrive(job("j2"), "second");
		expect(sent).toEqual([]);
		loop.stepBoundary();
		expect(sent).toEqual([{ carries: ["first", "second"], point: "boundary", trigger: true }]);
		loop.stepBoundary();
		expect(loop.settle()).toBe(false);
		expect(sent).toHaveLength(1);
	});

	it("waits for the idle window, and one that the window held joins a run that starts meanwhile at its first step", () => {
		const { loop, sent, arrive } = loopRig({ windowMs: () => 2000 });
		arrive(job("j1"), "held");
		vi.advanceTimersByTime(1999);
		expect(sent).toEqual([]);
		loop.signal("run_start");
		// The window ended with the run's start: its time passing delivers nothing on its own.
		vi.advanceTimersByTime(10_000);
		expect(sent).toEqual([]);
		loop.stepBoundary();
		expect(sent).toEqual([{ carries: ["held"], point: "boundary", trigger: true }]);
	});

	it("starts an idle session's turn once the window has passed", () => {
		const { sent, arrive } = loopRig({ windowMs: () => 2000 });
		arrive(job("j1"), "one");
		arrive(job("j2"), "two");
		vi.advanceTimersByTime(2000);
		expect(sent).toEqual([{ carries: ["one", "two"], point: "idle", trigger: true }]);
	});
});

describe("an urgent event interrupts", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("stops the step in progress once and is delivered ahead of what was already waiting", () => {
		const interrupt = vi.fn();
		const { loop, sent, arrive } = loopRig({ interrupt });
		loop.signal("run_start");
		arrive(job("j1"), "regular");
		arrive(mail(1, true), "urgent");
		arrive(mail(2, true), "urgent too");
		expect(interrupt).toHaveBeenCalledTimes(1);
		// The stopped step's boundary delivers nothing: the batch starts the turn after the run has stopped.
		loop.stepBoundary();
		expect(sent).toEqual([]);
		// The host asks whether the stop was the loop's own before it lets the run settle.
		expect(loop.takeInterrupt()).toBe(true);
		expect(loop.settle()).toBe(true);
		expect(sent).toEqual([{ carries: ["urgent", "urgent too", "regular"], point: "settle", trigger: true }]);
	});

	it("reaches an idle session at once, without the window, taking what the window held with it", () => {
		const { sent, arrive } = loopRig({ windowMs: () => 2000 });
		arrive(job("j1"), "regular");
		expect(sent).toEqual([]);
		arrive(mail(1, true), "urgent");
		expect(sent).toEqual([{ carries: ["urgent", "regular"], point: "idle", trigger: true }]);
		vi.advanceTimersByTime(10_000);
		expect(sent).toHaveLength(1);
	});

	it("is first at the next step when the run cannot be stopped", () => {
		const interrupt = vi.fn(() => {
			throw new Error("cannot abort");
		});
		const { loop, sent, arrive } = loopRig({ interrupt });
		loop.signal("run_start");
		arrive(job("j1"), "regular");
		arrive(mail(1, true), "urgent");
		expect(interrupt).toHaveBeenCalledTimes(1);
		loop.stepBoundary();
		expect(sent).toEqual([{ carries: ["urgent", "regular"], point: "boundary", trigger: true }]);
	});

	it("does not stop a compaction: it is first once the lock is released", () => {
		const interrupt = vi.fn();
		const { loop, sent, arrive } = loopRig({ interrupt });
		loop.signal("run_start");
		loop.lock();
		arrive(job("j1"), "regular");
		arrive(mail(1, true), "urgent");
		expect(interrupt).not.toHaveBeenCalled();
		expect(sent).toEqual([]);
		loop.unlock();
		expect(sent).toEqual([{ carries: ["urgent", "regular"], point: "drain", trigger: true }]);
	});
});

function liveRig(send?: (sent: Sent) => void | Promise<void>) {
	const sent: Sent[] = [];
	const interrupt = vi.fn();
	const live = new LiveLoop<string>({
		catalog: wakeCatalog,
		windowMs: () => 0,
		send: (batch, point) => {
			const record = sentOf(batch, point);
			sent.push(record);
			return send?.(record);
		},
		failed: (error) => {
			throw error;
		},
		interrupt,
	});
	const arrive = (event: PayloadEvent, carry: string) =>
		live.take({ event, source, wake: true, priority: priorityOfEvent(event), carry });
	return { live, sent, interrupt, arrive };
}

describe("a stop is not answered with a new turn", () => {
	it("hands over what a run held when the user stopped it, asking for no turn", () => {
		const { live, sent, arrive } = liveRig();
		live.runStarted();
		arrive(job("j1"), "held");
		live.settled(false, true);
		expect(sent).toEqual([{ carries: ["held"], point: "settle", trigger: false }]);
		// The session is idle again: the next event wakes it as usual.
		arrive(job("j2"), "later");
		expect(sent[1]).toEqual({ carries: ["later"], point: "idle", trigger: true });
	});

	it("starts the next turn when the loop itself stopped the run for an urgent message", () => {
		const { live, sent, interrupt, arrive } = liveRig();
		live.runStarted();
		arrive(mail(1, true), "urgent");
		expect(interrupt).toHaveBeenCalledTimes(1);
		live.settled(false, true);
		expect(sent).toEqual([{ carries: ["urgent"], point: "settle", trigger: true }]);
	});

	it("hands over what waited behind a compaction the user cancelled, asking for no turn", () => {
		const { live, sent, arrive } = liveRig();
		live.compactionStarted();
		arrive(job("j1"), "behind the lock");
		void live.compactionEnded(true);
		expect(sent).toEqual([{ carries: ["behind the lock"], point: "drain", trigger: false }]);
	});

	it("starts a turn for what waited behind a compaction that finished or failed on its own", () => {
		const { live, sent, arrive } = liveRig();
		live.compactionStarted();
		arrive(job("j1"), "behind the lock");
		void live.compactionEnded(false);
		expect(sent).toEqual([{ carries: ["behind the lock"], point: "drain", trigger: true }]);
	});

	it("covers what arrives while the cancelled compaction's hand-over is still being written", async () => {
		let release!: () => void;
		const writing = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { live, sent, arrive } = liveRig((record) =>
			record.carries.includes("behind the lock") ? writing : undefined,
		);
		live.compactionStarted();
		arrive(job("j1"), "behind the lock");
		const ended = live.compactionEnded(true);
		arrive(job("j2"), "during the hand-over");
		release();
		await ended;
		await new Promise((resolve) => setImmediate(resolve));
		expect(sent).toEqual([
			{ carries: ["behind the lock"], point: "drain", trigger: false },
			expect.objectContaining({ carries: ["during the hand-over"], trigger: false }),
		]);
	});
});
