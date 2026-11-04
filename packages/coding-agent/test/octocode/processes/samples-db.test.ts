import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processSamples, type AgentDb } from "../../../../db/src/api.ts";
import { openAgentDb } from "../../../src/config/database.ts";
import { tmp } from "../helpers.ts";

let agent: AgentDb;
beforeEach(() => {
	agent = openAgentDb(path.join(tmp(), "samples.db"));
});
afterEach(() => agent.close());

const sample = (over: Partial<processSamples.ProcessSample> = {}): processSamples.ProcessSample => ({
	at: 1_000,
	pid: 4242,
	started: "1700000000",
	ppid: 1,
	role: "main",
	title: "octocode-main-01a1a2c5",
	id: "01a1a2c5",
	sessionId: "01a1a2c5-eb93-75f9-8dc5-67f9daa09bdb",
	agentId: null,
	ownerPid: null,
	ownerStarted: null,
	rss: 100,
	heapUsed: 40,
	ended: false,
	children: [{ pid: 4300, started: "1700000005", ppid: 4242, kind: "mcp", label: "node octocode-mcp", rss: 2048 }],
	...over,
});

describe("processSamples", () => {
	it("stores a sample with its owned children and reads it back oldest first", () => {
		processSamples.record(agent.db, sample({ at: 2_000, rss: 120 }));
		processSamples.record(agent.db, sample({ at: 1_000 }));
		const rows = processSamples.since(agent.db, 0);
		expect(rows.map((row) => row.at)).toEqual([1_000, 2_000]);
		expect(rows[1]).toEqual(sample({ at: 2_000, rss: 120 }));
	});

	it("returns only samples at or after the cutoff", () => {
		processSamples.record(agent.db, sample({ at: 1_000 }));
		processSamples.record(agent.db, sample({ at: 5_000 }));
		expect(processSamples.since(agent.db, 5_000).map((row) => row.at)).toEqual([5_000]);
	});

	it("prunes samples older than the cutoff and reports how many went", () => {
		for (const at of [1_000, 2_000, 3_000]) processSamples.record(agent.db, sample({ at }));
		expect(processSamples.pruneBefore(agent.db, 3_000)).toBe(2);
		expect(processSamples.since(agent.db, 0).map((row) => row.at)).toEqual([3_000]);
	});

	it("works on a database created before the table existed", () => {
		expect(processSamples.since(agent.db, 0)).toEqual([]);
		expect(processSamples.pruneBefore(agent.db, 10)).toBe(0);
	});

	it("keeps one row per process and instant, so a repeated write replaces it", () => {
		processSamples.record(agent.db, sample({ at: 1_000, rss: 1 }));
		processSamples.record(agent.db, sample({ at: 1_000, rss: 2 }));
		expect(processSamples.since(agent.db, 0).map((row) => row.rss)).toEqual([2]);
	});
});
