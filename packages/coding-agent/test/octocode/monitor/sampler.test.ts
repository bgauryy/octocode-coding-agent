import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDb, type MachineSample, machineSamples } from "../../../../db/src/api.ts";
import { openAgentDb } from "../../../src/storage/database.ts";
import type { MachineFigures } from "../../../src/octocode/monitor/readers.ts";
import { MACHINE_SAMPLE_RETENTION_MS, startMachineSampler } from "../../../src/octocode/monitor/sampler.ts";
import { tmp } from "../helpers.ts";

let agent: AgentDb;
beforeEach(() => {
	agent = openAgentDb(path.join(tmp(), "machine.db"));
});
afterEach(() => agent.close());

const figures: MachineFigures = {
	load1: 2,
	load5: 2,
	load15: 2,
	cores: 8,
	memTotal: 1000,
	memAvailable: 500,
	swapUsed: 0,
	swapTotal: 0,
	gpu: 5,
};

function sampler(holder: string, clock: { at: number }, seen: Array<[number, boolean]>, errors: unknown[] = []) {
	return startMachineSampler({
		db: agent.db,
		holder,
		pid: holder.length,
		intervalMs: 60_000,
		now: () => clock.at,
		readFigures: async () => figures,
		readProcesses: async () => [],
		onSample: (sample: MachineSample, own: boolean) => seen.push([sample.at, own]),
		onError: (error) => errors.push(error),
	});
}

describe("machine sampler", () => {
	it("samples on one process only; the others get the holder's samples from the database", async () => {
		const clock = { at: 60_000 };
		const first: Array<[number, boolean]> = [];
		const second: Array<[number, boolean]> = [];
		const a = sampler("a", clock, first);
		await a.tick();
		const b = sampler("bb", clock, second);
		await b.tick();
		clock.at = 120_000;
		await a.tick();
		await b.tick();
		await b.tick(); // nothing new: not handed over twice
		expect(first).toEqual([
			[60_000, true],
			[120_000, true],
		]);
		expect(second).toEqual([
			[60_000, false],
			[120_000, false],
		]);
		expect(machineSamples.since(agent.db, 0)).toHaveLength(2);
		a.stop();
		b.stop();
	});

	it("hands the lease over at once when the holder stops, and after it runs out when the holder dies", async () => {
		const clock = { at: 60_000 };
		const a = sampler("a", clock, []);
		await a.tick();
		a.stop();
		const seenByB: Array<[number, boolean]> = [];
		const b = sampler("bb", clock, seenByB);
		clock.at = 61_000;
		await b.tick();
		expect(seenByB.at(-1)).toEqual([61_000, true]);
		// b dies without releasing: c waits until the lease (2.5 intervals) runs out.
		const seenByC: Array<[number, boolean]> = [];
		const c = sampler("ccc", clock, seenByC);
		clock.at = 61_000 + 149_000;
		await c.tick();
		expect(seenByC.at(-1)).toEqual([61_000, false]);
		clock.at = 61_000 + 150_000;
		await c.tick();
		expect(seenByC.at(-1)).toEqual([211_000, true]);
		b.stop();
		c.stop();
	});

	it("deletes samples older than a day", async () => {
		const old = { at: 1_000, ...figures, processes: [] };
		machineSamples.record(agent.db, old);
		const clock = { at: 1_000 + MACHINE_SAMPLE_RETENTION_MS + 1 };
		const a = sampler("a", clock, []);
		await a.tick();
		expect(machineSamples.since(agent.db, 0).map((row) => row.at)).toEqual([clock.at]);
		a.stop();
	});

	it("reports a reader failure and keeps sampling", async () => {
		const errors: unknown[] = [];
		let fail = true;
		const a = startMachineSampler({
			db: agent.db,
			holder: "a",
			intervalMs: 60_000,
			now: () => (fail ? 60_000 : 120_000),
			readFigures: async () => {
				if (fail) throw new Error("ioreg timed out");
				return figures;
			},
			readProcesses: async () => [],
			onSample: () => undefined,
			onError: (error) => errors.push(error),
		});
		await a.tick();
		expect(errors).toEqual([new Error("ioreg timed out")]);
		fail = false;
		await a.tick();
		expect(machineSamples.since(agent.db, 0)).toHaveLength(1);
		a.stop();
	});
});
