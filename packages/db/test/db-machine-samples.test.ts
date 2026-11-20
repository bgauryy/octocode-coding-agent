import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { machineSamples, openDatabase, purge, type AgentDb, type MachineSample } from "../src/api.ts";
import { tmp } from "./helpers.ts";

let agent: AgentDb;
beforeEach(() => {
	const dir = tmp();
	agent = openDatabase({
		file: path.join(dir, "agent.db"),
		mirrorFile: path.join(dir, "transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	});
});
afterEach(() => agent.close());

const sample = (over: Partial<MachineSample> = {}): MachineSample => ({
	at: 60_000,
	load1: 17.39,
	load5: 21.12,
	load15: 21.1,
	cores: 12,
	memTotal: 32 * 2 ** 30,
	memAvailable: 15 * 2 ** 30,
	swapUsed: 8312 * 2 ** 20,
	swapTotal: 9216 * 2 ** 20,
	gpu: 28,
	processes: [
		{ pid: 76174, ppid: 1, command: "node", cpu: 140.5, rss: 900 * 2 ** 20, owner: "octocode-agent-main-3cb050d2" },
		{ pid: 500, ppid: 1, command: "WindowServer", cpu: 20, rss: 300 * 2 ** 20, owner: null },
	],
	...over,
});

describe("machineSamples", () => {
	it("stores samples and reads them back oldest first, with nulls for unknown figures", () => {
		machineSamples.record(agent.db, sample({ at: 120_000, gpu: null, memAvailable: null }));
		machineSamples.record(agent.db, sample());
		const rows = machineSamples.since(agent.db, 0);
		expect(rows.map((row) => row.at)).toEqual([60_000, 120_000]);
		expect(rows[0]).toEqual(sample());
		expect(rows[1]).toMatchObject({ gpu: null, memAvailable: null });
		expect(machineSamples.latest(agent.db)?.at).toBe(120_000);
		expect(machineSamples.since(agent.db, 120_000).map((row) => row.at)).toEqual([120_000]);
	});

	it("has no latest sample before the first one", () => {
		expect(machineSamples.latest(agent.db)).toBeUndefined();
	});

	it("replaces a second sample taken at the same instant", () => {
		machineSamples.record(agent.db, sample({ gpu: 10 }));
		machineSamples.record(agent.db, sample({ gpu: 90 }));
		expect(machineSamples.since(agent.db, 0).map((row) => row.gpu)).toEqual([90]);
	});

	it("prunes samples older than the cutoff and reports how many went", () => {
		for (const at of [1, 2, 3]) machineSamples.record(agent.db, sample({ at: at * 60_000 }));
		expect(machineSamples.pruneBefore(agent.db, 3 * 60_000)).toBe(2);
		expect(machineSamples.since(agent.db, 0).map((row) => row.at)).toEqual([3 * 60_000]);
	});

	it("lets one holder sample at a time until it releases or its lease runs out", () => {
		expect(machineSamples.acquire(agent.db, "p1", 1, 1_000, 90_000)).toBe(true);
		expect(machineSamples.acquire(agent.db, "p2", 2, 2_000, 90_000)).toBe(false);
		// Renewing keeps the first acquisition time and moves the expiry.
		expect(machineSamples.acquire(agent.db, "p1", 1, 60_000, 90_000)).toBe(true);
		expect(machineSamples.holderAt(agent.db, 60_000)).toEqual({
			holder: "p1",
			pid: 1,
			acquiredAt: 1_000,
			expiresAt: 150_000,
		});
		// p1 stopped renewing (it died): once the lease ran out p2 takes over.
		expect(machineSamples.acquire(agent.db, "p2", 2, 149_999, 90_000)).toBe(false);
		expect(machineSamples.acquire(agent.db, "p2", 2, 150_000, 90_000)).toBe(true);
		expect(machineSamples.holderAt(agent.db, 150_000)).toMatchObject({ holder: "p2", acquiredAt: 150_000 });
		expect(machineSamples.holderAt(agent.db, 240_000)).toBeUndefined();
		// Only the holder can release; then anyone can take it at once.
		expect(machineSamples.release(agent.db, "p1")).toBe(false);
		expect(machineSamples.release(agent.db, "p2")).toBe(true);
		expect(machineSamples.acquire(agent.db, "p3", 3, 151_000, 90_000)).toBe(true);
	});

	it("is emptied by the all-data purge, which creates nothing on a file without it", () => {
		expect(purge.all(agent.db, agent.mirror.db).machine_samples).toBe(0);
		expect(
			agent.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='machine_samples'").get(),
		).toBeUndefined();
		machineSamples.record(agent.db, sample());
		machineSamples.acquire(agent.db, "p1", 1, 1_000, 90_000);
		expect(purge.all(agent.db, agent.mirror.db).machine_samples).toBe(1);
		expect(machineSamples.since(agent.db, 0)).toEqual([]);
		expect(machineSamples.holderAt(agent.db, 1_000)).toBeUndefined();
	});
});
