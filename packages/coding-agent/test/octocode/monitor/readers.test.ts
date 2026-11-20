import { describe, expect, it } from "vitest";
import { busiest, parseCpuTable } from "../../../src/octocode/monitor/busiest.ts";
import {
	type MachineReaderDeps,
	parseIoregGpu,
	parseMeminfo,
	parseNvidiaSmi,
	parseSwapUsage,
	readMachine,
} from "../../../src/octocode/monitor/readers.ts";

const GiB = 2 ** 30;
const MiB = 2 ** 20;

const deps = (over: Partial<MachineReaderDeps>): MachineReaderDeps => ({
	platform: "darwin",
	run: async () => undefined,
	readText: async () => "",
	loadavg: () => [17.39, 21.12, 21.1],
	cores: () => 12,
	totalmem: () => 32 * GiB,
	freemem: () => 4 * GiB,
	...over,
});

describe("machine readers", () => {
	it("parses macOS swap, GPU and Linux meminfo and nvidia-smi output", () => {
		expect(parseSwapUsage("total = 9216.00M  used = 8312.81M  free = 903.19M  (encrypted)")).toEqual({
			used: Math.round(8312.81 * MiB),
			total: 9216 * MiB,
		});
		expect(parseSwapUsage("")).toEqual({ used: 0, total: 0 });
		expect(parseIoregGpu('| "Device Utilization %"=28, x\n"Device Utilization %"=61')).toBe(61);
		expect(parseIoregGpu("no accelerator")).toBeNull();
		expect(parseMeminfo("MemTotal: 100 kB\nMemAvailable:   40 kB\nSwapTotal: 10 kB\nSwapFree: 4 kB\n")).toEqual({
			available: 40 * 1024,
			swapUsed: 6 * 1024,
			swapTotal: 10 * 1024,
		});
		expect(parseMeminfo("MemTotal: 100 kB\n")).toEqual({ available: null, swapUsed: 0, swapTotal: 0 });
		expect(parseNvidiaSmi("12\n87\n")).toBe(87);
		expect(parseNvidiaSmi("No devices were found\n")).toBeNull();
	});

	it("reads macOS figures from sysctl and ioreg, the pressure level as the share of memory left", async () => {
		const calls: string[] = [];
		const figures = await readMachine(
			deps({
				run: async (file) => {
					calls.push(file);
					return file === "sysctl"
						? "47\ntotal = 9216.00M  used = 8312.81M  free = 903.19M  (encrypted)\n"
						: '"Device Utilization %"=28';
				},
			}),
		);
		expect(calls.sort()).toEqual(["ioreg", "sysctl"]);
		expect(figures).toEqual({
			load1: 17.39,
			load5: 21.12,
			load15: 21.1,
			cores: 12,
			memTotal: 32 * GiB,
			memAvailable: Math.round(32 * GiB * 0.47),
			swapUsed: Math.round(8312.81 * MiB),
			swapTotal: 9216 * MiB,
			gpu: 28,
		});
	});

	it("reads Linux figures without a GPU when nvidia-smi is missing, and Node's figures elsewhere", async () => {
		const linux = await readMachine(
			deps({
				platform: "linux",
				readText: async () => "MemAvailable: 1024 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
			}),
		);
		expect(linux).toMatchObject({ memAvailable: 1024 * 1024, swapUsed: 0, swapTotal: 0, gpu: null });
		const windows = await readMachine(deps({ platform: "win32" }));
		expect(windows).toMatchObject({ memAvailable: 4 * GiB, swapUsed: 0, gpu: null });
	});

	it("fails loudly when a reader fails for another reason than a missing program", async () => {
		const failing = deps({
			run: async () => {
				throw new Error("sysctl timed out");
			},
		});
		await expect(readMachine(failing)).rejects.toThrow("sysctl timed out");
	});
});

describe("busiest processes", () => {
	const table = parseCpuTable(
		[
			"    1     0   0.0   1000 /sbin/launchd",
			"76174     1  12.0 900000 octocode-agent-main-3cb050d2",
			"14042 76174   0.5  50000 /bin/zsh -c yarn tsc",
			"14108 14042 283.6 3098080 /Users/x/node_modules/@typescript/lib/tsc --noEmit",
			"  330     1  86.1 4519440 /System/Library/FSEvents.framework/fseventsd",
			"  400     1   1.0    100 /usr/bin/idle",
			"garbage line",
		].join("\n"),
	);

	it("parses ps rows and drops lines that do not parse", () => {
		expect(table).toHaveLength(6);
		expect(table[3]).toEqual({
			pid: 14108,
			ppid: 14042,
			cpu: 283.6,
			rssKb: 3098080,
			command: "/Users/x/node_modules/@typescript/lib/tsc --noEmit",
		});
	});

	it("keeps the top by CPU and by memory, each with the Octocode process that owns it", () => {
		const top = busiest(table, 2);
		expect(top.map((row) => [row.pid, row.command, row.owner])).toEqual([
			[14108, "tsc", "octocode-agent-main-3cb050d2"],
			[330, "fseventsd", null],
		]);
		const wider = busiest(table, 3);
		expect(wider.map((row) => row.pid)).toEqual([14108, 330, 76174]);
		expect(wider[2]).toMatchObject({ command: "octocode-agent-main-3cb050d2", owner: "octocode-agent-main-3cb050d2" });
		expect(wider[0].rss).toBe(3098080 * 1024);
	});
});
