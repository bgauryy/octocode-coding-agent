import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbStamp } from "../../../../db/src/api.ts";
import type { AgentDb } from "../../../../db/src/api.ts";
import { openAgentDb } from "../../../src/storage/database.ts";
import { DbEventStore } from "../../../src/octocode/events/loop/db-store.ts";
import { EventLoop } from "../../../src/octocode/events/loop/loop.ts";
import { makeSource } from "../../../src/octocode/events/source.ts";
import type { PayloadEvent } from "../../../src/octocode/events/topics.ts";
import { wakeCatalog } from "../../../src/octocode/wake/loop-catalog.ts";
import { registerFixtureWorkspace } from "../backlog-fixture.ts";
import { tmp } from "../helpers.ts";
import { percentile, record } from "./lib.ts";

/**
 * R13: what the durable event log costs (writes, reads, the follower's tick) and whether a replay returns every event that
 * has a `body`. The log exists only with the event loop, so there is no old-loop column: the old gate wrote nothing.
 */
const config = { name: "event log (new)", settings: {} };
const source = makeSource("child", "a", "in-process", "proven");
const report = (id: string): PayloadEvent => ({
	kind: "agent.report",
	agent: "a",
	role: "implementer",
	outcome: "done",
	reportId: id,
});
const ms = (from: number) => performance.now() - from;

let agent: AgentDb;
beforeEach(() => {
	agent = openAgentDb(path.join(tmp(), "r13-log.db"));
	registerFixtureWorkspace(agent, "w1");
});
afterEach(() => agent.close());

const open = (subscriber = "loop-1") => DbEventStore.open(agent, { workspaceId: "w1", sessionId: "s1", subscriber });

describe("the durable event log", () => {
	it("costs per append, per commit and per follower tick", async () => {
		const store = await open();
		const n = 300;
		const appends: number[] = [];
		const commits: number[] = [];
		for (let i = 0; i < n; i++) {
			let t = performance.now();
			const { seq } = await store.append({
				topic: "job.exit",
				key: `job:${i}:0`,
				at: i,
				source,
				payload: { job: `j${i}`, exit: 0, durationMs: 1, startedAt: 0 },
				digest: `job j${i} exit 0`,
			});
			appends.push(ms(t));
			t = performance.now();
			await store.commit(seq);
			commits.push(ms(t));
		}
		appends.sort((a, b) => a - b);
		commits.sort((a, b) => a - b);
		const ticks = 2000;
		const t = performance.now();
		for (let i = 0; i < ticks; i++) dbStamp(agent.file);
		const stampUs = (ms(t) / ticks) * 1000;
		record("log", config, {
			events: n,
			appendP50Ms: +percentile(appends, 50).toFixed(3),
			appendP95Ms: +percentile(appends, 95).toFixed(3),
			commitP50Ms: +percentile(commits, 50).toFixed(3),
			commitP95Ms: +percentile(commits, 95).toFixed(3),
			followerStampUs: +stampUs.toFixed(1),
			followerStampsPerMinute: 60,
		});
		expect(store.unread()).toEqual([]);
	}, 60_000);

	it("replays every event that has a body, once", async () => {
		const before = await open();
		const loop = new EventLoop<string>({
			store: before,
			catalog: wakeCatalog,
			deliver: () => undefined,
			onError: (error) => {
				throw error;
			},
		});
		loop.signal("run_start");
		const withBody = 40;
		const withoutBody = 10;
		for (let i = 0; i < withBody + withoutBody; i++) {
			await loop.publish({
				event: report(`r${i}`),
				source,
				wake: true,
				priority: "regular",
				carry: "x",
				dedupeKey: `r${i}`,
				...(i < withBody ? { body: { taskId: `r${i}` } } : {}),
			});
		}
		const got: string[] = [];
		const after = new EventLoop<string>({
			store: await open(),
			catalog: wakeCatalog,
			deliver: (batch) => void got.push(...batch.entries.map((entry) => `${entry.seq}`)),
			onError: (error) => {
				throw error;
			},
		});
		const replayed = await after.replay(() => "y", { keep: () => true, wakes: () => true });
		const distinct = new Set(got).size;
		record("replay", config, {
			published: withBody + withoutBody,
			withBody,
			replayed,
			delivered: got.length,
			distinct,
		});
		expect(got.length).toBe(distinct);
		expect(replayed).toBe(got.length);
	});
});
