import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDb } from "../../../../db/src/api.ts";
import { openAgentDb } from "../../../src/storage/database.ts";
import { DbEventStore } from "../../../src/octocode/events/loop/db-store.ts";
import { EventLoop } from "../../../src/octocode/events/loop/loop.ts";
import {
	fromEventRow,
	fromSubscriptionRow,
	toNewEvent,
	toNewSubscription,
	type NewAgentEvent,
} from "../../../src/octocode/events/loop/rows.ts";
import { MemoryEventStore } from "../../../src/octocode/events/loop/store.ts";
import { wakeCatalog } from "../../../src/octocode/wake/loop-catalog.ts";
import { installLive } from "../../../src/octocode/wake/live-host.ts";
import { WakeGate } from "../../../src/octocode/wake/gate.ts";
import { makeSource } from "../../../src/octocode/events/source.ts";
import type { PayloadEvent, Subscription } from "../../../src/octocode/events/topics.ts";
import { agents, events } from "../../../../db/src/api.ts";
import { holdWrite } from "../../../../db/test/hold-write.ts";
import { registerFixtureWorkspace } from "../backlog-fixture.ts";
import { tmp } from "../helpers.ts";
import { fakeCtx, fakeHost } from "../fake-host.ts";

const source = makeSource("child", "a", "in-process", "proven");
const newEvent = (job: string, over: Partial<NewAgentEvent> = {}): NewAgentEvent => ({
	topic: "job.exit",
	key: `job:${job}:0`,
	at: 1_000,
	source,
	payload: { job, exit: 0, durationMs: 5, startedAt: 0 },
	digest: `job ${job} exit 0`,
	...over,
});
const report = (reportId: string): PayloadEvent => ({
	kind: "agent.report",
	agent: "a",
	role: "implementer",
	outcome: "done",
	reportId,
});

let agent: AgentDb;
beforeEach(() => {
	agent = openAgentDb(path.join(tmp(), "loop-store.db"));
	registerFixtureWorkspace(agent, "w1");
});
afterEach(() => agent.close());

describe("the event row mapping", () => {
	it("round-trips an event through the database", () => {
		const written = newEvent("j1", { ref: { kind: "job", id: "j1" } as never, dedupeKey: "job:j1" });
		const { seq } = events.append(agent.db, toNewEvent("w1", "s1", written));
		const [row] = events.read(agent.db, { workspaceId: "w1", after: 0 });
		expect(fromEventRow(row)).toEqual({ ...written, seq });
	});

	it("refuses a row it cannot read", () => {
		events.append(agent.db, { ...toNewEvent("w1", undefined, newEvent("j1")), payload: "{not json" });
		events.append(agent.db, { ...toNewEvent("w1", undefined, newEvent("j2")), topic: "job.nope" });
		const [bad, unknown] = events.read(agent.db, { workspaceId: "w1", after: 0 });
		expect(() => fromEventRow(bad)).toThrow(/not JSON/);
		expect(() => fromEventRow(unknown)).toThrow(/unknown topic/);
	});

	it("round-trips a subscription", async () => {
		const { eventSubscriptions } = await import("../../../../db/src/api.ts");
		const subscription: Subscription = {
			subscriber: "main",
			topic: "job.*",
			where: { exit: 1 },
			deliver: "wake",
			durable: true,
			action: { type: "message", to: "main", text: "look" } as never,
			once: true,
			costGate: { maxPerHour: 4 },
		};
		const row = eventSubscriptions.upsert(agent.db, toNewSubscription({ workspaceId: "w1" }, subscription, 0, 1_000));
		expect(fromSubscriptionRow(row).subscription).toEqual(subscription);
	});
});

describe("the durable event store", () => {
	const open = (subscriber = "loop-1") =>
		DbEventStore.open(agent, { workspaceId: "w1", sessionId: "s1", subscriber, now: () => 5_000 });

	it.each(["subscribe", "append", "commit"] as const)(
		"lets timers run while a peer holds the writer during %s",
		async (stage) => {
			agents.setBusyTimeout(agent.db, 500);
			const store = stage === "subscribe" ? undefined : await open();
			const queued = stage === "commit" ? await store!.append(newEvent("first")) : undefined;
			const holder = await holdWrite(agent.file);
			let released = false;
			const timer = setTimeout(() => {
				released = true;
				holder.release();
			}, 5);
			try {
				if (stage === "subscribe") expect((await open()).offset()).toBe(0);
				if (stage === "append") {
					const [a, repeat, b] = await Promise.all([
						store!.append(newEvent("first", { dedupeKey: "same" })),
						store!.append(newEvent("duplicate", { dedupeKey: "same" })),
						store!.append(newEvent("last")),
					]);
					expect(repeat).toEqual({ inserted: false, seq: a.seq });
					expect(store!.unread().map((row) => row.seq)).toEqual([a.seq, b.seq]);
				}
				if (stage === "commit") {
					await store!.commit(queued!.seq);
					expect(store!.unread()).toEqual([]);
				}
				expect(released).toBe(true);
			} finally {
				clearTimeout(timer);
				await holder.close();
			}
		},
	);

	it("appends, drops a repeated dedupe key and reads from the offset", async () => {
		const store = await open();
		expect(await store.append(newEvent("j1", { dedupeKey: "k" }))).toEqual({ seq: 1, inserted: true });
		expect(await store.append(newEvent("j1", { dedupeKey: "k" }))).toEqual({ seq: 1, inserted: false });
		// the database may skip a number for the refused insert: order is what counts, not contiguity
		const second = (await store.append(newEvent("j2"))).seq;
		expect(second).toBeGreaterThan(1);
		expect(store.unread().map((event) => event.seq)).toEqual([1, second]);
		await store.commit(1);
		expect(store.offset()).toBe(1);
		expect(store.unread().map((event) => event.seq)).toEqual([second]);
		await store.commit(0);
		expect(store.offset()).toBe(1);
	});

	it("keeps the offset across a restart and starts a new subscriber at the end of the log", async () => {
		const first = await open();
		await first.append(newEvent("j1"));
		const second = (await first.append(newEvent("j2"))).seq;
		await first.commit(1);
		expect((await open()).unread().map((event) => event.seq)).toEqual([second]);
		expect((await open("loop-2")).unread()).toEqual([]);
	});

	it("replays what a loop did not deliver, once, to the loop that starts again", async () => {
		const before = await open();
		const loop = new EventLoop<string>({
			store: before,
			catalog: wakeCatalog,
			deliver: () => undefined,
			onError: () => undefined,
		});
		loop.signal("run_start");
		await loop.publish({ event: report("r1"), source, wake: true, priority: "regular", carry: "x" });
		expect(before.offset()).toBe(0);

		const sent: string[] = [];
		const after = new EventLoop<string>({
			store: await open(),
			catalog: wakeCatalog,
			deliver: (batch) => void sent.push(...batch.lines.map((line) => line.key)),
			onError: () => undefined,
		});
		expect(await after.replay(() => "y")).toBe(1);
		expect(sent).toEqual(["report:r1"]);
		expect((await open()).unread()).toEqual([]);
	});

	it("replays a backlog across pages and advances past records without a deliverable body", async () => {
		const store = await open();
		for (let i = 0; i < 425; i++) await store.append(newEvent(String(i)));
		const seen: string[][] = [];
		const loop = new EventLoop<string>({
			store,
			catalog: wakeCatalog,
			deliver: (batch) => void seen.push(batch.entries.map((e) => e.carry)),
			onError: (error) => {
				throw error;
			},
		});
		const include = { keep: (event: { seq: number }) => event.seq > 200, wakes: () => true };
		expect(await loop.replay((_event, row) => row.digest, include)).toBe(225);
		expect(seen).toEqual([Array.from({ length: 225 }, (_, i) => `job ${i + 200} exit 0`)]);
		expect(store.unread()).toEqual([]);
	});

	it("accepts input during a blocked append and leaves the closing session's completion for exactly one replay", async () => {
		const before = await open();
		const delivered: string[] = [];
		const loop = new EventLoop<string>({
			store: before,
			catalog: wakeCatalog,
			deliver: (batch) => void delivered.push(...batch.entries.map((entry) => entry.carry)),
			onError: (error) => {
				throw error;
			},
		});
		const holder = await holdWrite(agent.file);
		try {
			const save = loop.publish({
				event: report("pending"),
				source,
				wake: true,
				priority: "regular",
				carry: "old",
				dedupeKey: "r",
				body: { taskId: "pending" },
			});
			loop.input("typed", "user");
			expect(delivered).toEqual(["user"]);
			loop.close();
			holder.release();
			await save;
			await before.settled();
			expect(delivered).toEqual(["user"]);
			const resumed = new EventLoop<string>({
				store: await open(),
				catalog: wakeCatalog,
				deliver: (batch) => void delivered.push(...batch.entries.map((entry) => entry.carry)),
				onError: (error) => {
					throw error;
				},
			});
			expect(await resumed.replay((_event, row) => String(row.body?.taskId))).toBe(1);
			expect(await resumed.replay(() => "duplicate")).toBe(0);
			expect(delivered).toEqual(["user", "pending"]);
		} finally {
			await holder.close();
		}
	});

	it("does not attach or deliver into a replacement session after an earlier registration finishes", async () => {
		const host = fakeHost({ runtime: { eventWindowSeconds: 0 } });
		const ctx = fakeCtx({ cwd: tmp() });
		const gate = new WakeGate(host.api);
		const starting = Promise.withResolvers<MemoryEventStore>();
		let stores = 0;
		const replacement = new MemoryEventStore();
		const live = installLive(host.api, gate, { store: () => (++stores === 1 ? starting.promise : replacement) });
		const first = host.fire("session_start", {}, ctx);
		const early = gate.emit(
			report("old"),
			{ customType: "report", content: "old", display: true },
			{ triggerTurn: true },
		);
		const refused = expect(early).rejects.toThrow(/session ended/i);
		const closing = host.fire("session_shutdown", {}, ctx);
		await host.fire("session_start", {}, ctx);
		expect(live.loop()).toBeDefined();
		starting.resolve(new MemoryEventStore());
		await Promise.all([first, closing, refused]);
		expect(host.sent).toEqual([]);
		await gate.emit(report("new"), { customType: "report", content: "new", display: true }, { triggerTurn: true });
		expect(host.sent).toHaveLength(1);
		expect(host.sent[0].message.content).toContain("new");
	});
	it("behaves as the memory store does", async () => {
		for (const store of [await open(), new MemoryEventStore()]) {
			const a = await store.append(newEvent("a", { dedupeKey: "d" }));
			const again = await store.append(newEvent("a", { dedupeKey: "d" }));
			expect([a.inserted, again.inserted, again.seq]).toEqual([true, false, a.seq]);
			await store.commit(a.seq);
			expect(store.unread()).toEqual([]);
		}
	});
});
