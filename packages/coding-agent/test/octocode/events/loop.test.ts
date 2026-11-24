import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLoop, type LoopOptions } from "../../../src/octocode/events/loop/loop.ts";
import { MemoryEventStore } from "../../../src/octocode/events/loop/store.ts";
import { buildBatch } from "../../../src/octocode/events/loop/batch.ts";
import { LOOP_INPUTS, LOOP_STATES, nextState } from "../../../src/octocode/events/loop/state.ts";
import {
	MAX_BATCH_LINES,
	type Batch,
	type DeliveryPoint,
	type Logged,
} from "../../../src/octocode/events/loop/types.ts";
import { wakeCatalog } from "../../../src/octocode/wake/loop-catalog.ts";
import { makeSource } from "../../../src/octocode/events/source.ts";
import type { PayloadEvent } from "../../../src/octocode/events/topics.ts";

const child = (id: string) => makeSource("child", id, "in-process", "proven");
const report = (id: string): PayloadEvent => ({
	kind: "agent.report",
	agent: id,
	role: "implementer",
	outcome: "done",
	reportId: id,
});
const jobExit = (job: string): PayloadEvent => ({ kind: "job.exit", job, exit: 0, durationMs: 1, startedAt: 0 });

interface Sent {
	batch: Batch<string>;
	point: DeliveryPoint;
}

function rig(over: Partial<LoopOptions<string>> = {}) {
	const sent: Sent[] = [];
	const errors: unknown[] = [];
	const store = new MemoryEventStore();
	const loop = new EventLoop<string>({
		catalog: wakeCatalog,
		store,
		deliver: (batch, point) => void sent.push({ batch, point }),
		onError: (error) => void errors.push(error),
		...over,
	});
	const wake = (event: PayloadEvent, carry = "x", extra: { dedupeKey?: string } = {}) =>
		loop.publish({
			event,
			source: child("a"),
			wake: true,
			priority: wakeCatalog.priority(event),
			carry,
			...(extra.dedupeKey ? { dedupeKey: extra.dedupeKey } : {}),
		});
	const ride = (event: PayloadEvent, carry = "x") =>
		loop.publish({ event, source: child("a"), wake: false, priority: "regular", carry });
	return { loop, sent, errors, store, wake, ride };
}

const carries = (sent: Sent) => sent.batch.entries.map((entry) => entry.carry);

describe("the loop's state machine", () => {
	it("moves every state on every input without leaving the set", () => {
		for (const state of LOOP_STATES)
			for (const input of LOOP_INPUTS) expect(LOOP_STATES).toContain(nextState(state, input));
	});

	it("runs idle → running → nudged → stopping → locked → draining → idle", () => {
		let state = nextState("idle", "run_start");
		expect(state).toBe("running");
		state = nextState(state, "nudge");
		expect(state).toBe("nudged");
		state = nextState(state, "stop");
		expect(state).toBe("stopping");
		state = nextState(state, "lock");
		expect(state).toBe("locked");
		state = nextState(state, "unlock");
		expect(state).toBe("draining");
		expect(nextState(state, "drained")).toBe("idle");
	});

	it("keeps a lock through a late run end", () => {
		expect(nextState("locked", "run_end")).toBe("locked");
		expect(nextState("stopping", "run_end")).toBe("stopping");
	});
});

describe("a batch", () => {
	const logged = (event: PayloadEvent, seq: number, source = child("a")): Logged<string> => ({
		type: "event",
		event,
		source,
		wake: true,
		priority: "regular",
		carry: "c",
		seq,
		queue: "Q3",
		arrival: seq,
	});

	it("delivers raw entries without formatting a digest and computes the optional summary once", () => {
		const describeEvent = vi.fn(wakeCatalog.describe);
		const batch = buildBatch({ ...wakeCatalog, describe: describeEvent }, [logged(jobExit("a"), 1)]);
		expect(batch.entries).toHaveLength(1);
		expect(batch.trigger).toBe(true);
		expect(describeEvent).not.toHaveBeenCalled();
		expect(batch.lines).toHaveLength(1);
		expect(batch.more).toBe(0);
		expect(batch.range).toBeUndefined();
		expect(describeEvent).toHaveBeenCalledTimes(1);
	});

	it("turns events with one coalescing key into one counted line", () => {
		const batch = buildBatch(wakeCatalog, [
			logged(jobExit("j1"), 1),
			logged(jobExit("j1"), 2),
			logged(jobExit("j2"), 3),
		]);
		expect(batch.lines.map((line) => [line.key, line.count])).toEqual([
			[expect.stringContaining("j1"), 2],
			[expect.stringContaining("j2"), 1],
		]);
		expect(batch.more).toBe(0);
		expect(batch.trigger).toBe(true);
	});

	it("caps the lines, shares them between sources and names the log range it left out", () => {
		const chatty = child("chatty");
		const quiet = child("quiet");
		const entries = [
			...Array.from({ length: 30 }, (_, index) => logged(jobExit(`c${index}`), index + 1, chatty)),
			logged(jobExit("q"), 31, quiet),
		];
		const batch = buildBatch(wakeCatalog, entries);
		expect(batch.lines).toHaveLength(MAX_BATCH_LINES);
		expect(batch.lines.some((line) => line.source.id === "quiet")).toBe(true);
		expect(batch.more).toBe(31 - MAX_BATCH_LINES);
		expect(batch.range?.to).toBeGreaterThan(batch.range?.from ?? Number.POSITIVE_INFINITY);
	});

	it("asks for no turn when nothing in it wakes", () => {
		const entry = { ...logged(jobExit("j"), 1), wake: false };
		expect(buildBatch(wakeCatalog, [entry]).trigger).toBe(false);
	});
});

describe("the event loop", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("moves a burst accumulated during compaction to its resumed run in one batch", () => {
		const { loop, sent } = rig();
		loop.lock();
		const notification = {
			event: jobExit("many"),
			priority: "regular" as const,
			wake: true,
			source: child("worker"),
			carry: "result",
		};
		const count = 150_000;
		for (let index = 0; index < count; index++) loop.notify(notification);
		loop.signal("unlock");
		loop.signal("run_start");
		loop.stepBoundary();
		expect(sent).toHaveLength(1);
		expect(sent[0].batch.entries).toHaveLength(count);
		expect(sent[0].batch.lines[0].count).toBe(count);
		expect(loop.queued()).toEqual({ Q1: 0, Q2: 0, Q3: 0 });
	});

	it("defers a reentrant wake until the next tick and gives queued input priority", async () => {
		const batches: string[][] = [];
		let replay: Promise<number> | undefined;
		const { loop, wake, store } = rig({
			deliver(batch) {
				batches.push(batch.entries.map((entry) => entry.carry));
				if (batches.length === 1) {
					wake(jobExit("second"), "completion");
					loop.input("typed", "user");
					replay = loop.replay(() => "duplicate");
				}
			},
		});
		wake(jobExit("first"), "first");
		expect(batches).toEqual([["first"]]);
		expect(await replay).toBe(0);
		expect(store.offset()).toBe(1);
		await vi.runAllTimersAsync();
		expect(batches).toEqual([["first"], ["user", "completion"]]);
		expect(store.offset()).toBe(2);
	});

	it("delivers a wake to an idle session at once when there is no window", () => {
		const { wake, sent } = rig();
		wake(jobExit("j1"), "one");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.point).toBe("idle");
		expect(carries(sent[0])).toEqual(["one"]);
	});

	it("holds the window: events that arrive together are one batch, delivered once at its end", () => {
		const { wake, sent, loop } = rig({ windowMs: () => 2000 });
		wake(jobExit("j1"), "one");
		vi.advanceTimersByTime(1500);
		wake(jobExit("j2"), "two");
		expect(sent).toHaveLength(0);
		vi.advanceTimersByTime(600);
		expect(sent).toHaveLength(1);
		expect(carries(sent[0])).toEqual(["one", "two"]);
		expect(loop.queued()).toEqual({ Q1: 0, Q2: 0, Q3: 0 });
	});

	it("does not hold typed input, and the input takes everything queued with it", () => {
		const { wake, sent, loop } = rig({ windowMs: () => 2000 });
		wake(jobExit("j1"), "event");
		loop.input("hello", "typed");
		expect(sent).toHaveLength(1);
		expect(carries(sent[0])).toEqual(["typed", "event"]);
		vi.advanceTimersByTime(5000);
		expect(sent).toHaveLength(1);
	});

	it("never opens a window for an event that only rides along", () => {
		const { ride, sent, loop } = rig({ windowMs: () => 2000 });
		ride(jobExit("j1"), "quiet");
		vi.advanceTimersByTime(10_000);
		expect(sent).toHaveLength(0);
		expect(loop.queued().Q3).toBe(1);
	});

	it("lets a riding event go out with the next wake", () => {
		const { ride, wake, sent } = rig();
		ride(jobExit("j1"), "quiet");
		wake(jobExit("j2"), "loud");
		expect(carries(sent[0])).toEqual(["quiet", "loud"]);
	});

	it("queues events during a run and delivers them as one batch when the run would stop", () => {
		const { wake, sent, loop } = rig();
		loop.signal("run_start");
		wake(jobExit("j1"), "one");
		wake(jobExit("j2"), "two");
		expect(sent).toHaveLength(0);
		expect(loop.settle()).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.point).toBe("settle");
		expect(carries(sent[0])).toEqual(["one", "two"]);
	});

	it("ends the run when nothing asks for a turn", () => {
		const { ride, sent, loop } = rig();
		loop.signal("run_start");
		ride(jobExit("j1"));
		expect(loop.settle()).toBe(false);
		expect(sent).toHaveLength(0);
		expect(loop.state).toBe("idle");
	});

	it("delivers typed input first and both completions at the next step boundary", () => {
		const { wake, sent, loop } = rig();
		loop.signal("run_start");
		wake(jobExit("j1"), "later");
		wake(report("b"), "report");
		loop.input("now", "typed");
		expect(sent).toHaveLength(0);
		loop.stepBoundary();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.point).toBe("boundary");
		expect(carries(sent[0])).toEqual(["typed", "later", "report"]);
		expect(loop.queued()).toEqual({ Q1: 0, Q2: 0, Q3: 0 });
	});

	it("holds urgent mail past the aborted tool boundary until the stopped run can start its successor", () => {
		const interrupt = vi.fn();
		const { wake, sent, loop } = rig({ interrupt });
		loop.signal("run_start");
		const message = { kind: "agent.message", from: "parent", replyRequired: false, interrupt: true } as const;
		wake({ ...message, id: 1 }, "urgent mail");
		wake({ ...message, id: 2 }, "second mail");
		expect(interrupt).toHaveBeenCalledOnce();
		loop.stepBoundary();
		expect(sent).toHaveLength(0);
		expect(loop.takeInterrupt()).toBe(true);
		expect(loop.settle()).toBe(true);
		expect(carries(sent[0])).toEqual(["urgent mail", "second mail"]);
		expect(sent[0].point).toBe("settle");
	});

	it("delivers nothing while compaction holds the lock, then everything once, user input first", () => {
		const { wake, sent, loop } = rig({ windowMs: () => 2000 });
		loop.signal("run_start");
		loop.lock();
		wake(jobExit("j1"), "event");
		loop.input("typed", "typed");
		vi.advanceTimersByTime(10_000);
		expect(sent).toHaveLength(0);
		expect(loop.state).toBe("locked");
		loop.unlock();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.point).toBe("drain");
		expect(carries(sent[0])).toEqual(["typed", "event"]);
		expect(loop.state).toBe("running");
		loop.signal("run_end");
		expect(loop.state).toBe("idle");
	});

	it("drops a queued window when compaction takes the lock", () => {
		const { wake, sent, loop } = rig({ windowMs: () => 2000 });
		wake(jobExit("j1"), "event");
		loop.lock();
		vi.advanceTimersByTime(5000);
		expect(sent).toHaveLength(0);
		loop.unlock();
		expect(carries(sent[0])).toEqual(["event"]);
	});

	it("delivers nothing at a settle that follows a hard stop", () => {
		const { wake, sent, loop } = rig();
		loop.signal("run_start");
		loop.signal("stop");
		wake(jobExit("j1"), "finished");
		loop.input("later", "user");
		loop.stepBoundary();
		expect(loop.settle()).toBe(false);
		expect(sent).toHaveLength(0);
		loop.lock();
		loop.unlock();
		expect(sent).toHaveLength(1);
	});

	it("runs Q0 at once in every state, leaving the queues untouched", () => {
		const { wake, loop } = rig();
		loop.signal("run_start");
		loop.lock();
		wake(jobExit("j1"));
		const acted = vi.fn(() => 7);
		expect(loop.preempt(acted)).toBe(7);
		expect(acted).toHaveBeenCalledTimes(1);
		expect(loop.queued().Q3).toBe(1);
	});

	it("drops an event whose dedupe key was already logged", async () => {
		const { wake, sent, loop } = rig({ windowMs: () => 2000 });
		expect((await wake(jobExit("j1"), "first", { dedupeKey: "job:j1" })).accepted).toBe(true);
		expect((await wake(jobExit("j1"), "again", { dedupeKey: "job:j1" })).accepted).toBe(false);
		vi.advanceTimersByTime(2100);
		expect(carries(sent[0])).toEqual(["first"]);
		expect(loop.queued().Q3).toBe(0);
	});

	it("gives each event its place in one order", async () => {
		const { wake, ride } = rig({ windowMs: () => 2000 });
		const events = await Promise.all([wake(jobExit("a")), ride(jobExit("b")), wake(jobExit("c"))]);
		expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
	});

	it("moves the offset past what was delivered only, so a restart replays the rest once", async () => {
		const { wake, ride, store, loop } = rig();
		ride(jobExit("held"), "held");
		wake(jobExit("j2"), "sent");
		// the riding event went out with the wake: everything is delivered
		expect(store.offset()).toBe(2);
		loop.signal("run_start");
		wake(report("b"), "left");
		expect(store.offset()).toBe(2);
		expect(store.unread().map((event) => event.seq)).toEqual([3]);

		const replayed: Sent[] = [];
		const restarted = new EventLoop<string>({
			catalog: wakeCatalog,
			store,
			deliver: (batch, point) => void replayed.push({ batch, point }),
			onError: () => undefined,
		});
		expect(await restarted.replay(() => "replayed")).toBe(1);
		// `agent.report` wakes by the catalog, so the replayed event is delivered, and once
		expect(replayed.map((each) => carries(each))).toEqual([["replayed"]]);
		expect(store.offset()).toBe(3);
		expect(await restarted.replay(() => "replayed")).toBe(0);
	});

	it("puts a batch back and reports the failure when delivery throws", () => {
		let fail = true;
		const sent: Sent[] = [];
		const errors: unknown[] = [];
		const loop = new EventLoop<string>({
			catalog: wakeCatalog,
			store: new MemoryEventStore(),
			deliver: (batch, point) => {
				if (fail) throw new Error("send failed");
				sent.push({ batch, point });
			},
			onError: (error) => void errors.push(error),
		});
		loop.publish({ event: jobExit("j1"), source: child("a"), wake: true, priority: "regular", carry: "one" });
		expect(errors).toHaveLength(1);
		expect(loop.queued().Q3).toBe(1);
		fail = false;
		loop.flushNow();
		expect(carries(sent[0])).toEqual(["one"]);
	});

	it("holds everything back while an asynchronous delivery is in flight, then settles it", async () => {
		vi.useRealTimers();
		let release: () => void = () => undefined;
		const sent: Sent[] = [];
		const store = new MemoryEventStore();
		const loop = new EventLoop<string>({
			catalog: wakeCatalog,
			store,
			deliver: (batch, point) => {
				sent.push({ batch, point });
				return new Promise<void>((resolve) => void (release = resolve));
			},
			onError: () => undefined,
		});
		loop.publish({ event: jobExit("j1"), source: child("a"), wake: true, priority: "regular", carry: "one" });
		loop.publish({ event: jobExit("j2"), source: child("a"), wake: true, priority: "regular", carry: "two" });
		expect(sent).toHaveLength(1);
		expect(store.offset()).toBe(0);
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(sent).toHaveLength(2);
		expect(carries(sent[1])).toEqual(["two"]);
	});

	it("leaves no timer behind after dispose", () => {
		const { wake, sent, loop } = rig({ windowMs: () => 2000 });
		wake(jobExit("j1"));
		loop.dispose();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(5000);
		expect(sent).toHaveLength(0);
	});
});
