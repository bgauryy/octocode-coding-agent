import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processSamples, type AgentDb } from "../../../../db/src/api.ts";
import { openAgentDb } from "../../../src/storage/database.ts";
import {
	DEFAULT_SAMPLE_MINUTES,
	sampleIntervalMs,
	SAMPLE_RETENTION_MS,
	startProcessSampler,
} from "../../../src/octocode/processes/sampler.ts";
import type { ProcessRow } from "../../../src/octocode/processes/table.ts";
import { tmp } from "../helpers.ts";

let agent: AgentDb;
let failures: unknown[];
beforeEach(() => {
	failures = [];
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
	agent = openAgentDb(path.join(tmp(), "sampler.db"));
});
afterEach(() => {
	agent.close();
	vi.useRealTimers();
});

const row = (pid: number, ppid: number, command: string, started = "9000"): ProcessRow => ({
	pid,
	ppid,
	started,
	command,
	rssKb: 10,
});
const identity = () => ({
	role: "main",
	id: "aaaaaaaa",
	title: "octocode-main-aaaaaaaa",
	sessionId: "aaaaaaaa-1111",
	agentId: null,
	ownerPid: null,
	ownerStarted: null,
});
const start = (table: () => Promise<ProcessRow[] | undefined>, intervalMs = 60_000) =>
	startProcessSampler({
		db: agent.db,
		table,
		identity,
		selfPid: 100,
		started: "8000",
		ppid: 50,
		kinds: () => new Map([[101, "mcp"]]),
		memory: () => ({ rss: 123, heapUsed: 45 }),
		intervalMs,
		onError: (error) => void failures.push(error),
	});

describe("sampleIntervalMs", () => {
	it("defaults to five minutes, reads the environment and treats 0 as off", () => {
		expect(DEFAULT_SAMPLE_MINUTES).toBe(5);
		expect(sampleIntervalMs({})).toBe(5 * 60_000);
		expect(sampleIntervalMs({ OCTOCODE_PROCESS_SAMPLE_MINUTES: "2" })).toBe(120_000);
		expect(sampleIntervalMs({ OCTOCODE_PROCESS_SAMPLE_MINUTES: "0" })).toBe(0);
		expect(sampleIntervalMs({ OCTOCODE_PROCESS_SAMPLE_MINUTES: "soon" })).toBe(5 * 60_000);
		expect(sampleIntervalMs({ OCTOCODE_PROCESS_SAMPLE_MINUTES: "-3" })).toBe(5 * 60_000);
	});
});

describe("process sampler", () => {
	const table = async () => [
		row(100, 50, "octocode-main-aaaaaaaa", "8000"),
		row(101, 100, "node /x/octocode-mcp/dist/index.js"),
		row(102, 101, "/x/octocode mcp"),
		row(110, 100, "octocode-implementer-nifty-beak"),
		row(111, 110, "node /x/octocode-mcp/dist/index.js"),
		row(200, 1, "unrelated"),
	];

	it("records a sample at once: memory, identity and the children it owns, not those of a subagent", async () => {
		const sampler = await start(table);
		const [sample] = processSamples.since(agent.db, 0);
		expect(sample).toMatchObject({
			pid: 100,
			started: "8000",
			ppid: 50,
			role: "main",
			title: "octocode-main-aaaaaaaa",
			sessionId: "aaaaaaaa-1111",
			rss: 123,
			heapUsed: 45,
			ended: false,
			at: Date.now(),
		});
		expect(sample.children.map((child) => [child.pid, child.kind, child.ppid])).toEqual([
			[101, "mcp", 100],
			[102, "mcp", 101],
		]);
		await sampler.stop();
	});

	it("records again every interval while running", async () => {
		const sampler = await start(table, 60_000);
		await vi.advanceTimersByTimeAsync(3 * 60_000);
		expect(processSamples.since(agent.db, 0)).toHaveLength(4);
		await sampler.stop();
	});

	it("stops its timer and writes a final ended sample", async () => {
		const sampler = await start(table, 60_000);
		expect(vi.getTimerCount()).toBe(1);
		await sampler.stop();
		expect(vi.getTimerCount()).toBe(0);
		const rows = processSamples.since(agent.db, 0);
		expect(rows.at(-1)?.ended).toBe(true);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(processSamples.since(agent.db, 0)).toHaveLength(rows.length);
	});

	it("starts no timer when sampling is off, and still takes the first sample", async () => {
		const sampler = await start(table, 0);
		expect(vi.getTimerCount()).toBe(0);
		expect(processSamples.since(agent.db, 0)).toHaveLength(1);
		await sampler.stop();
	});

	it("records memory without children where the process table is unavailable", async () => {
		const sampler = await start(async () => undefined);
		expect(processSamples.since(agent.db, 0)[0]).toMatchObject({ rss: 123, children: [] });
		await sampler.stop();
	});

	it("prunes samples past the retention window", async () => {
		processSamples.record(agent.db, {
			...(processSamples.since(agent.db, 0)[0] ?? {
				pid: 9,
				started: "1",
				ppid: 1,
				role: "main",
				title: "t",
				id: "i",
				sessionId: null,
				agentId: null,
				ownerPid: null,
				ownerStarted: null,
				rss: 1,
				heapUsed: 1,
				ended: false,
				children: [],
			}),
			at: Date.now() - SAMPLE_RETENTION_MS - 1000,
		});
		const sampler = await start(table);
		expect(processSamples.since(agent.db, 0).every((sample) => sample.at >= Date.now() - SAMPLE_RETENTION_MS)).toBe(
			true,
		);
		await sampler.stop();
	});

	it("reports a failed database write to its caller instead of throwing into the session", async () => {
		const sampler = await start(table, 60_000);
		expect(failures).toEqual([]);
		agent.close();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(failures).toHaveLength(1);
		await expect(sampler.stop()).resolves.toBeUndefined();
		expect(failures.length).toBeGreaterThanOrEqual(2);
	});
});
