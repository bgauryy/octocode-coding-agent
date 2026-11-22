import { describe, expect, it } from "vitest";
import type { MachineSample } from "../../../../db/src/api.ts";
import { MachineRules, causeOf, readings, type MonitorThresholds } from "../../../src/octocode/monitor/rules.ts";
import { StuckJobWatch, type WatchedJob } from "../../../src/octocode/monitor/stuck-jobs.ts";

const GiB = 2 ** 30;
const t: MonitorThresholds = {
	samples: 3,
	cooldownMinutes: 15,
	loadPerCore: 1.5,
	memoryAvailablePercent: 10,
	swapPercent: 90,
	gpuPercent: 95,
};

const sample = (at: number, over: Partial<MachineSample> = {}): MachineSample => ({
	at,
	load1: 4,
	load5: 4,
	load15: 4,
	cores: 12,
	memTotal: 32 * GiB,
	memAvailable: 16 * GiB,
	swapUsed: 0,
	swapTotal: 0,
	gpu: 20,
	processes: [
		{ pid: 1, ppid: 0, command: "tsc", cpu: 280, rss: 3 * GiB, owner: "octocode-agent-main-aaaa" },
		{ pid: 2, ppid: 0, command: "node", cpu: 40, rss: 1 * GiB, owner: "octocode-agent-main-aaaa" },
		{ pid: 3, ppid: 0, command: "vitest", cpu: 150, rss: 6 * GiB, owner: "octocode-agent-implementer-bob" },
		{ pid: 4, ppid: 0, command: "fseventsd", cpu: 90, rss: 4 * GiB, owner: null },
	],
	...over,
});
const MIN = 60_000;

describe("machine rules", () => {
	it("reads each threshold, and trips nothing on a figure the machine does not report", () => {
		const hot = sample(0, { load1: 20, memAvailable: 2 * GiB, swapUsed: 95, swapTotal: 100, gpu: 99 });
		expect(readings(hot, t)).toEqual([
			{ rule: "load", value: 1.67, threshold: 1.5 },
			{ rule: "memory", value: 6.3, threshold: 10 },
			{ rule: "swap", value: 95, threshold: 90 },
			{ rule: "gpu", value: 99, threshold: 95 },
		]);
		expect(readings(sample(0, { memAvailable: null, gpu: null, cores: 0, load1: 99 }), t)).toEqual([]);
		const off = { ...t, loadPerCore: 0, memoryAvailablePercent: 0, swapPercent: 101, gpuPercent: 101 };
		expect(readings(hot, off)).toEqual([]);
	});

	it("names the Octocode process whose processes weigh most: CPU for load, memory for swap", () => {
		expect(causeOf(sample(0), "load").owner).toBe("octocode-agent-main-aaaa");
		expect(causeOf(sample(0), "swap").owner).toBe("octocode-agent-implementer-bob");
		expect(causeOf(sample(0), "swap").culprits.map((p) => p.command)).toEqual(["vitest", "fseventsd", "tsc"]);
		expect(causeOf(sample(0, { processes: [] }), "gpu")).toEqual({ owner: null, culprits: [] });
	});

	it("never blames a session for an editor or terminal host above it, nor for less memory than another program holds", () => {
		const helper = { pid: 10, ppid: 1, command: "Code Helper (Plugin)", cpu: 5, rss: 1.5 * GiB, owner: null };
		const session = {
			pid: 11,
			ppid: 10,
			command: "octocode-agent-main-aaaa",
			cpu: 2,
			rss: 0.5 * GiB,
			owner: "octocode-agent-main-aaaa",
		};
		const child = { pid: 12, ppid: 11, command: "vitest", cpu: 1, rss: 0.6 * GiB, owner: "octocode-agent-main-aaaa" };
		const swap = causeOf(sample(0, { processes: [session, child, helper] }), "swap");
		expect(swap.owner).toBeNull();
		expect(swap.culprits[0].command).toBe("Code Helper (Plugin)");
		const alone = causeOf(sample(0, { processes: [session, child] }), "swap");
		expect(alone.owner).toBe("octocode-agent-main-aaaa");
	});

	it("alerts after the streak, not again within the cooldown, and resets the streak when it clears", () => {
		const rules = new MachineRules(() => t);
		const hot = (at: number) => rules.observe(sample(at, { load1: 24 }));
		expect(hot(1 * MIN).alerts).toEqual([]);
		expect(hot(2 * MIN)).toEqual({ alerts: [], active: [] });
		const third = hot(3 * MIN);
		expect(third.alerts).toMatchObject([{ rule: "load", value: 2, streak: 3, owner: "octocode-agent-main-aaaa" }]);
		expect(third.active).toEqual([{ rule: "load", value: 2, threshold: 1.5 }]);
		expect(hot(4 * MIN)).toMatchObject({ alerts: [], active: [{ rule: "load" }] });
		// Clears: the footer mark goes, and a new streak must build up.
		expect(rules.observe(sample(5 * MIN))).toEqual({ alerts: [], active: [] });
		hot(6 * MIN);
		hot(7 * MIN);
		expect(hot(8 * MIN).alerts).toEqual([]); // streak met again, still within 15 min of the first alert
		expect(hot(18 * MIN).alerts).toMatchObject([{ rule: "load", streak: 4 }]);
	});
});

describe("stuck jobs", () => {
	const job: WatchedJob = { id: "bash-1", pid: 500, log: "/tmp/x.log", startedAt: 0, command: "yarn test" };

	it("reports a job silent and idle for the threshold once, and again only after it wrote something", async () => {
		let size = 10;
		let cpu = 0.2;
		let psCalls = 0;
		const watch = new StuckJobWatch({
			logSize: () => size,
			groupCpu: async () => {
				psCalls++;
				return new Map([[500, cpu]]);
			},
		});
		expect(await watch.check([job], 5 * MIN, 15)).toEqual([]);
		expect(psCalls).toBe(0); // not silent long enough: no ps
		expect(await watch.check([job], 15 * MIN, 15)).toMatchObject([{ id: "bash-1", silentMs: 15 * MIN, cpu: 0.2 }]);
		expect(await watch.check([job], 16 * MIN, 15)).toEqual([]);
		size = 20; // wrote again
		expect(await watch.check([job], 17 * MIN, 15)).toEqual([]);
		expect(await watch.check([job], 32 * MIN, 15)).toMatchObject([{ silentMs: 15 * MIN }]);
		// A silent job that computes is not stuck.
		cpu = 95;
		const busy = { ...job, id: "bash-2" };
		expect(await watch.check([busy], 60 * MIN, 15)).toEqual([]);
		expect(await watch.check([job], 60 * MIN, 0)).toEqual([]);
	});
});
