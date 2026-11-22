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
import { makeSource } from "../../../src/octocode/events/source.ts";
import type { PayloadEvent, Subscription } from "../../../src/octocode/events/topics.ts";
import { events } from "../../../../db/src/api.ts";
import { registerFixtureWorkspace } from "../backlog-fixture.ts";
import { tmp } from "../helpers.ts";

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
		new DbEventStore(agent.db, { workspaceId: "w1", sessionId: "s1", subscriber, now: () => 5_000 });

	it("appends, drops a repeated dedupe key and reads from the offset", () => {
		const store = open();
		expect(store.append(newEvent("j1", { dedupeKey: "k" }))).toEqual({ seq: 1, inserted: true });
		expect(store.append(newEvent("j1", { dedupeKey: "k" }))).toEqual({ seq: 1, inserted: false });
		// the database may skip a number for the refused insert: order is what counts, not contiguity
		const second = store.append(newEvent("j2")).seq;
		expect(second).toBeGreaterThan(1);
		expect(store.unread().map((event) => event.seq)).toEqual([1, second]);
		store.commit(1);
		expect(store.offset()).toBe(1);
		expect(store.unread().map((event) => event.seq)).toEqual([second]);
		store.commit(0);
		expect(store.offset()).toBe(1);
	});

	it("keeps the offset across a restart and starts a new subscriber at the end of the log", () => {
		const first = open();
		first.append(newEvent("j1"));
		const second = first.append(newEvent("j2")).seq;
		first.commit(1);
		expect(
			open()
				.unread()
				.map((event) => event.seq),
		).toEqual([second]);
		expect(open("loop-2").unread()).toEqual([]);
	});

	it("replays what a loop did not deliver, once, to the loop that starts again", () => {
		const before = open();
		const loop = new EventLoop<string>({
			store: before,
			catalog: wakeCatalog,
			deliver: () => undefined,
			onError: () => undefined,
		});
		loop.signal("run_start");
		loop.publish({ event: report("r1"), source, wake: true, steer: false, carry: "x" });
		expect(before.offset()).toBe(0);

		const sent: string[] = [];
		const after = new EventLoop<string>({
			store: open(),
			catalog: wakeCatalog,
			deliver: (batch) => void sent.push(...batch.lines.map((line) => line.key)),
			onError: () => undefined,
		});
		expect(after.replay(() => "y")).toBe(1);
		expect(sent).toEqual(["report:r1"]);
		expect(open().unread()).toEqual([]);
	});

	it("behaves as the memory store does", () => {
		for (const store of [open(), new MemoryEventStore()]) {
			const a = store.append(newEvent("a", { dedupeKey: "d" }));
			const again = store.append(newEvent("a", { dedupeKey: "d" }));
			expect([a.inserted, again.inserted, again.seq]).toEqual([true, false, a.seq]);
			store.commit(a.seq);
			expect(store.unread()).toEqual([]);
		}
	});
});
