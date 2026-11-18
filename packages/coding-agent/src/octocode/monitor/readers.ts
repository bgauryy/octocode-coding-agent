import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { MachineSample } from "../../../../db/src/api.ts";

/** The machine-wide figures of a sample: everything but its time and its processes. */
export type MachineFigures = Omit<MachineSample, "at" | "processes">;

/** Runs a command and returns its standard output, or undefined when the command does not exist on this machine. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string | undefined>;

const COMMAND_TIMEOUT_MS = 5_000;
const exec = promisify(execFile);

/** `execFile` with a timeout; a missing program (`ENOENT`) is the one failure that means "not on this machine". */
export const runCommand: CommandRunner = async (file, args) => {
	try {
		const { stdout } = await exec(file, [...args], {
			encoding: "utf8",
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: 64 * 1024 * 1024,
		});
		return stdout;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
};

const UNIT: Record<string, number> = { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 };

/** Bytes of `name = 9216.00M` in macOS `vm.swapusage` output (`total = … used = … free = …`); undefined when absent. */
function swapField(text: string, name: string): number | undefined {
	const match = new RegExp(`${name}\\s*=\\s*([\\d.]+)([KMGT])`).exec(text);
	return match ? Math.round(Number(match[1]) * UNIT[match[2]]) : undefined;
}

/** Used and total swap from `sysctl -n vm.swapusage`. */
export function parseSwapUsage(text: string): { used: number; total: number } {
	return { used: swapField(text, "used") ?? 0, total: swapField(text, "total") ?? 0 };
}

/** `MemAvailable`, `SwapTotal` and `SwapFree` of Linux `/proc/meminfo`, in bytes. */
export function parseMeminfo(text: string): { available: number | null; swapUsed: number; swapTotal: number } {
	const field = (name: string): number | undefined => {
		const match = new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text);
		return match ? Number(match[1]) * 1024 : undefined;
	};
	const swapTotal = field("SwapTotal") ?? 0;
	return {
		available: field("MemAvailable") ?? null,
		swapUsed: Math.max(0, swapTotal - (field("SwapFree") ?? swapTotal)),
		swapTotal,
	};
}

/** The busiest GPU's utilization from `ioreg -r -d 1 -c IOAccelerator` (macOS); null when no accelerator reports one. */
export function parseIoregGpu(text: string): number | null {
	const values = [...text.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map((match) => Number(match[1]));
	return values.length > 0 ? Math.max(...values) : null;
}

/** The busiest GPU's utilization from `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(text: string): number | null {
	const values = text
		.split("\n")
		.filter((line) => /^\s*\d+(\.\d+)?\s*$/.test(line))
		.map((line) => Number(line));
	return values.length > 0 ? Math.max(...values) : null;
}

export interface MachineReaderDeps {
	platform: NodeJS.Platform;
	run: CommandRunner;
	readText: (file: string) => Promise<string>;
	loadavg: () => number[];
	cores: () => number;
	totalmem: () => number;
	freemem: () => number;
}

const defaultDeps = (): MachineReaderDeps => ({
	platform: process.platform,
	run: runCommand,
	readText: (file) => readFile(file, "utf8"),
	loadavg: () => os.loadavg(),
	cores: () => os.availableParallelism(),
	totalmem: () => os.totalmem(),
	freemem: () => os.freemem(),
});

/**
 * The machine's load, memory, swap and GPU figures. macOS: `sysctl` (memory pressure level, swap) and `ioreg` (GPU), no
 * root needed; Linux: `/proc/meminfo` and `nvidia-smi` when installed; elsewhere (Windows) what Node reports, with no
 * swap and no GPU. A figure the machine cannot give is null; a reader that fails for another reason throws.
 */
export async function readMachine(deps: MachineReaderDeps = defaultDeps()): Promise<MachineFigures> {
	const [load1 = 0, load5 = 0, load15 = 0] = deps.loadavg();
	const memTotal = deps.totalmem();
	const base = { load1, load5, load15, cores: deps.cores(), memTotal };
	if (deps.platform === "darwin") {
		const [sysctl, ioreg] = await Promise.all([
			deps.run("sysctl", ["-n", "kern.memorystatus_level", "vm.swapusage"]),
			deps.run("ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"]),
		]);
		const [levelLine = "", swapLine = ""] = (sysctl ?? "").split("\n");
		// The memory pressure level is the percentage of memory the system can still hand out.
		const level = Number(levelLine.trim());
		const swap = parseSwapUsage(swapLine);
		return {
			...base,
			memAvailable: levelLine.trim() !== "" && Number.isFinite(level) ? Math.round((memTotal * level) / 100) : null,
			swapUsed: swap.used,
			swapTotal: swap.total,
			gpu: ioreg === undefined ? null : parseIoregGpu(ioreg),
		};
	}
	if (deps.platform === "linux") {
		const [meminfo, smi] = await Promise.all([
			deps.readText("/proc/meminfo"),
			deps.run("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"]),
		]);
		const memory = parseMeminfo(meminfo);
		return {
			...base,
			memAvailable: memory.available,
			swapUsed: memory.swapUsed,
			swapTotal: memory.swapTotal,
			gpu: smi === undefined ? null : parseNvidiaSmi(smi),
		};
	}
	return { ...base, memAvailable: deps.freemem(), swapUsed: 0, swapTotal: 0, gpu: null };
}
