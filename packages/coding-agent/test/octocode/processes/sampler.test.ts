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

	it("keeps large finite intervals within Node's timer range, including multiplication overflow", () => {
		expect(sampleIntervalMs({ OCTOCODE_PROCESS_SAMPLE_MINUTES: "100000" })).toBe(2_147_483_647);
		expect(sampleIntervalMs({ OCTOCODE_PROCESS_SAMPLE_MINUTES: "1e308" })).toBe(2_147_483_647);
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
		const sampler = start(table);
		await sampler.idle();
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
		sampler.stop();
	});

	it("records again every interval while running", async () => {
		const sampler = start(table, 60_000);
		await vi.advanceTimersByTimeAsync(3 * 60_000);
		expect(processSamples.since(agent.db, 0)).toHaveLength(4);
		sampler.stop();
	});

	it("drops elapsed intervals while a process table read is pending", async () => {
		let answer: (rows: ProcessRow[]) => void = () => undefined;
		const read = vi
			.fn<() => Promise<ProcessRow[]>>()
			.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
			.mockImplementation(table);
		const sampler = start(read, 1000);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(read).toHaveBeenCalledTimes(1);
		answer(await table());
		await sampler.idle();
		expect(read).toHaveBeenCalledTimes(1);
		expect(processSamples.since(agent.db, 0)).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(read).toHaveBeenCalledTimes(2);
		sampler.stop();
	});

	it("does not launch queued process reads after shutdown", async () => {
		let answer: (rows: ProcessRow[]) => void = () => undefined;
		const read = vi
			.fn<() => Promise<ProcessRow[]>>()
			.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
			.mockImplementation(table);
		const sampler = start(read, 1000);
		await vi.advanceTimersByTimeAsync(5000);
		sampler.stop();
		answer(await table());
		await sampler.idle();
		expect(read).toHaveBeenCalledTimes(1);
		expect(processSamples.since(agent.db, 0).map((sample) => sample.ended)).toEqual([true]);
	});

	it("keeps direct millisecond overrides within Node's timer range", async () => {
		const read = vi.fn(table);
		const sampler = start(read, 2_147_483_648);
		await vi.advanceTimersByTimeAsync(10);
		expect(read).toHaveBeenCalledTimes(1);
		sampler.stop();
	});

	it("records deeply nested process trees without a recursive stack overflow", async () => {
		const rows = Array.from({ length: 12_000 }, (_, index) => row(101 + index, 100 + index, "worker"));
		const sampler = start(async () => rows, 0);
		await sampler.idle();
		expect(failures).toEqual([]);
		expect(processSamples.since(agent.db, 0)[0]?.children).toHaveLength(rows.length);
		sampler.stop();
	});

	it("stops its timer and writes a final ended sample", async () => {
		const sampler = start(table, 60_000);
		await sampler.idle();
		await vi.advanceTimersByTimeAsync(1000);
		expect(vi.getTimerCount()).toBe(1);
		sampler.stop();
		expect(vi.getTimerCount()).toBe(0);
		const rows = processSamples.since(agent.db, 0);
		expect(rows.at(-1)?.ended).toBe(true);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(processSamples.since(agent.db, 0)).toHaveLength(rows.length);
	});

	it("starts no timer when sampling is off, and still takes the first sample", async () => {
		const sampler = start(table, 0);
		await sampler.idle();
		expect(vi.getTimerCount()).toBe(0);
		expect(processSamples.since(agent.db, 0)).toHaveLength(1);
		sampler.stop();
	});

	it("records memory without children where the process table is unavailable", async () => {
		const sampler = start(async () => undefined);
		await sampler.idle();
		expect(processSamples.since(agent.db, 0)[0]).toMatchObject({ rss: 123, children: [] });
		sampler.stop();
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
		const sampler = start(table);
		await sampler.idle();
		expect(processSamples.since(agent.db, 0).every((sample) => sample.at >= Date.now() - SAMPLE_RETENTION_MS)).toBe(
			true,
		);
		sampler.stop();
	});

	it("reports a failed database write to its caller instead of throwing into the session", async () => {
		const sampler = start(table, 60_000);
		await sampler.idle();
		expect(failures).toEqual([]);
		agent.close();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(failures).toHaveLength(1);
		expect(() => sampler.stop()).not.toThrow();
		expect(failures.length).toBeGreaterThanOrEqual(2);
	});

	it("returns before the first table read ends: nothing waits for `ps`", async () => {
		let answer: (rows: ProcessRow[]) => void = () => undefined;
		const sampler = start(() => new Promise((resolve) => (answer = resolve)));
		// Nothing is recorded yet, and the caller already has the sampler.
		await vi.advanceTimersByTimeAsync(1000);
		expect(processSamples.since(agent.db, 0)).toEqual([]);
		answer(await table());
		await sampler.idle();
		expect(processSamples.since(agent.db, 0)).toHaveLength(1);
		sampler.stop();
	});

	it("writes the final sample at once from the last table read, without reading the table again", async () => {
		let reads = 0;
		const sampler = start(async () => {
			reads++;
			return table();
		});
		await sampler.idle();
		await vi.advanceTimersByTimeAsync(1000);
		sampler.stop();
		expect(reads).toBe(1);
		const last = processSamples.since(agent.db, 0).at(-1);
		expect(last).toMatchObject({ ended: true, at: Date.now() });
		expect(last?.children.map((child) => child.pid)).toEqual([101, 102]);
	});

	it("keeps the final sample the newest when stopped while a table read runs", async () => {
		let answer: (rows: ProcessRow[]) => void = () => undefined;
		const sampler = start(() => new Promise((resolve) => (answer = resolve)));
		sampler.stop();
		// No table was read yet: the final sample still records the process, without children.
		expect(processSamples.since(agent.db, 0)).toMatchObject([{ ended: true, children: [] }]);
		await vi.advanceTimersByTimeAsync(1000);
		answer(await table());
		await sampler.idle();
		expect(processSamples.since(agent.db, 0).map((sample) => sample.ended)).toEqual([true]);
	});

	it("skips a periodic sample while another connection holds the database, without waiting or a notice", async () => {
		const sampler = start(table);
		await sampler.idle();
		expect(processSamples.since(agent.db, 0)).toHaveLength(1);
		const other = openAgentDb(path.join(path.dirname(agent.file), "sampler.db"));
		try {
			// Held across the interval: the sample of this tick meets a locked database.
			other.db.exec("BEGIN IMMEDIATE");
			await vi.advanceTimersByTimeAsync(60_000);
			await sampler.idle();
			other.db.exec("ROLLBACK");
			expect(failures).toEqual([]);
			expect(processSamples.since(agent.db, 0)).toHaveLength(1);
			// The next interval records again.
			await vi.advanceTimersByTimeAsync(60_000);
			await sampler.idle();
			expect(processSamples.since(agent.db, 0)).toHaveLength(2);
		} finally {
			sampler.stop();
			other.close();
		}
	});
});
