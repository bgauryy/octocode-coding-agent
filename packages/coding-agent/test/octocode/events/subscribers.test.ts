import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDb, events } from "../../../../db/src/api.ts";
import { openAgentDb } from "../../../src/storage/database.ts";
import { toNewEvent, type NewAgentEvent } from "../../../src/octocode/events/loop/rows.ts";
import { makeSource } from "../../../src/octocode/events/source.ts";
import type { AgentEvent } from "../../../src/octocode/events/topics.ts";
import { EventSubscribers, type SubscribersOptions } from "../../../src/octocode/events/subscribers.ts";
import { registerFixtureWorkspace } from "../backlog-fixture.ts";
import { tmp } from "../helpers.ts";

const source = makeSource("child", "a", "in-process", "proven");
const job = (id: string): NewAgentEvent => ({
	topic: "job.exit",
	key: `job:${id}:0`,
	at: 1_000,
	source,
	payload: { job: id, exit: 0, durationMs: 5, startedAt: 0 },
	digest: `job ${id} exit 0`,
});
const report = (id: string): NewAgentEvent => ({
	topic: "agent.ended",
	key: `ended:${id}`,
	at: 1_000,
	source,
	payload: { agent: id, role: "implementer", outcome: "done" } as never,
	digest: `agent ${id} ended`,
});

let agent: AgentDb;
const failures: string[] = [];
const make = (over: Partial<SubscribersOptions> = {}) =>
	new EventSubscribers(agent.db, {
		workspaceId: "w1",
		sessionId: "s1",
		failed: (hook, event, error) => failures.push(`${hook}:${event.seq}:${String(error)}`),
		...over,
	});
const keys = (seen: AgentEvent[]) => seen.map((event) => event.key);

beforeEach(() => {
	failures.length = 0;
	agent = openAgentDb(path.join(tmp(), "subscribers.db"));
	registerFixtureWorkspace(agent, "w1");
});
afterEach(() => agent.close());

describe("hook subscribers", () => {
	it("hands a subscribed hook each event of its topic once, in order", async () => {
		const subscribers = make();
		const seen: AgentEvent[] = [];
		subscribers.subscribe({ hook: "h", topic: "job.exit", handle: (event) => void seen.push(event) });
		await subscribers.publish(job("1"));
		await subscribers.publish(report("x"));
		await subscribers.publish(job("2"));
		await subscribers.pump();
		await subscribers.pump();
		expect(keys(seen)).toEqual(["job:1:0", "job:2:0"]);
	});

	it("does not hand the same event twice when a duplicate is published", async () => {
		const subscribers = make();
		const seen: AgentEvent[] = [];
		subscribers.subscribe({ hook: "h", topic: "job.*", handle: (event) => void seen.push(event) });
		await subscribers.publish({ ...job("1"), dedupeKey: "d" });
		await subscribers.publish({ ...job("1"), dedupeKey: "d" });
		expect(keys(seen)).toEqual(["job:1:0"]);
	});

	it("keeps the offset across a restart: handled events stay handled, missed ones are handled once", async () => {
		const first = make();
		const seen: AgentEvent[] = [];
		const hook = { hook: "h", topic: "job.exit" as const, handle: (event: AgentEvent) => void seen.push(event) };
		first.subscribe(hook);
		await first.publish(job("1"));
		await first.close();

		// While the session is down an event lands in the log.
		events.append(agent.db, toNewEvent("w1", "s1", job("2")));

		const second = make();
		second.subscribe(hook);
		await second.pump();
		await second.pump();
		expect(keys(seen)).toEqual(["job:1:0", "job:2:0"]);

		const third = make();
		third.subscribe(hook);
		await third.pump();
		expect(keys(seen)).toEqual(["job:1:0", "job:2:0"]);
	});

	it("records a failing hook and still delivers to it and to the other hooks", async () => {
		const subscribers = make();
		const good: AgentEvent[] = [];
		const bad: AgentEvent[] = [];
		subscribers.subscribe({
			hook: "bad",
			topic: "job.exit",
			handle: (event) => {
				bad.push(event);
				throw new Error("boom");
			},
		});
		subscribers.subscribe({ hook: "good", topic: "job.exit", handle: (event) => void good.push(event) });
		await subscribers.publish(job("1"));
		await subscribers.publish(job("2"));
		expect(keys(bad)).toEqual(["job:1:0", "job:2:0"]);
		expect(keys(good)).toEqual(["job:1:0", "job:2:0"]);
		expect(failures).toHaveLength(2);
		expect(failures[0]).toMatch(/^bad:\d+:Error: boom/);

		// A failed event is not retried after a restart.
		const again = make();
		const retried: AgentEvent[] = [];
		again.subscribe({ hook: "bad", topic: "job.exit", handle: (event) => void retried.push(event) });
		await again.pump();
		expect(retried).toEqual([]);
	});

	it("starts a new subscription at the end of the log and keeps sessions apart", async () => {
		events.append(agent.db, toNewEvent("w1", "s1", job("old")));
		const a = make();
		const b = make({ sessionId: "s2" });
		const seenA: AgentEvent[] = [];
		const seenB: AgentEvent[] = [];
		a.subscribe({ hook: "h", topic: "job.exit", handle: (event) => void seenA.push(event) });
		b.subscribe({ hook: "h", topic: "job.exit", handle: (event) => void seenB.push(event) });
		await a.publish(job("a"));
		await b.publish(job("b"));
		expect(keys(seenA)).toEqual(["job:a:0"]);
		expect(keys(seenB)).toEqual(["job:b:0"]);
	});

	it("stops delivering to an unsubscribed hook, and refuses a subscribe once closed", async () => {
		const subscribers = make();
		const seen: AgentEvent[] = [];
		const stop = subscribers.subscribe({ hook: "h", topic: "job.exit", handle: (event) => void seen.push(event) });
		await subscribers.publish(job("1"));
		stop();
		await subscribers.publish(job("2"));
		expect(keys(seen)).toEqual(["job:1:0"]);
		await subscribers.close();
		expect(() => subscribers.subscribe({ hook: "h", topic: "job.exit", handle: () => undefined })).toThrow(/closed/);
	});
});
