import type { MachineProcess, MachineSample } from "../../../../db/src/api.ts";

/**
 * The machine thresholds: each sample is checked against them, a threshold alerts after `samples` consecutive samples
 * over it, and the same threshold alerts again only after `cooldownMinutes`. Every session runs the same rules on the
 * same samples, so they agree on what alerts; each alert names the Octocode process whose processes weigh most in it.
 */

export interface MonitorThresholds {
	samples: number;
	cooldownMinutes: number;
	loadPerCore: number;
	memoryAvailablePercent: number;
	swapPercent: number;
	gpuPercent: number;
}

export type MachineRule = "load" | "memory" | "swap" | "gpu";

/** A threshold a sample is over: `value` against `threshold`, in the rule's unit. */
export interface Reading {
	rule: MachineRule;
	value: number;
	threshold: number;
}

export interface MachineAlert extends Reading {
	at: number;
	/** Consecutive samples over the threshold. */
	streak: number;
	/** The Octocode process title whose processes weigh most in this rule; null when none of the busiest is Octocode's. */
	owner: string | null;
	/** The busiest processes for this rule (CPU or memory), at most three. */
	culprits: MachineProcess[];
}

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The thresholds `sample` is over. A figure the machine does not report trips nothing. */
export function readings(sample: MachineSample, t: MonitorThresholds): Reading[] {
	const found: Reading[] = [];
	if (t.loadPerCore > 0 && sample.cores > 0 && sample.load1 / sample.cores >= t.loadPerCore)
		found.push({ rule: "load", value: round(sample.load1 / sample.cores, 2), threshold: t.loadPerCore });
	if (sample.memAvailable !== null && sample.memTotal > 0) {
		const percent = (sample.memAvailable / sample.memTotal) * 100;
		if (t.memoryAvailablePercent > 0 && percent <= t.memoryAvailablePercent)
			found.push({ rule: "memory", value: round(percent), threshold: t.memoryAvailablePercent });
	}
	if (sample.swapTotal > 0) {
		const percent = (sample.swapUsed / sample.swapTotal) * 100;
		if (percent >= t.swapPercent) found.push({ rule: "swap", value: round(percent), threshold: t.swapPercent });
	}
	if (sample.gpu !== null && sample.gpu >= t.gpuPercent)
		found.push({ rule: "gpu", value: round(sample.gpu), threshold: t.gpuPercent });
	return found;
}

/** CPU drives load and GPU (no per-process GPU figure exists); memory drives memory and swap. */
const weight = (rule: MachineRule) =>
	rule === "memory" || rule === "swap" ? (p: MachineProcess) => p.rss : (p: MachineProcess) => p.cpu;

/** The three busiest processes for `rule` and the Octocode process whose processes add up to the most of it. */
export function causeOf(sample: MachineSample, rule: MachineRule): Pick<MachineAlert, "owner" | "culprits"> {
	const of = weight(rule);
	const culprits = [...sample.processes].sort((a, b) => of(b) - of(a)).slice(0, 3);
	const byOwner = new Map<string, number>();
	for (const process of sample.processes)
		if (process.owner) byOwner.set(process.owner, (byOwner.get(process.owner) ?? 0) + of(process));
	let owner: string | null = null;
	let most = 0;
	for (const [title, total] of byOwner)
		if (total > most || (total === most && owner !== null && title < owner)) [owner, most] = [title, total];
	return { owner, culprits };
}

export class MachineRules {
	readonly #thresholds: () => MonitorThresholds;
	readonly #streak = new Map<MachineRule, number>();
	readonly #alertedAt = new Map<MachineRule, number>();

	constructor(thresholds: () => MonitorThresholds) {
		this.#thresholds = thresholds;
	}

	/**
	 * Checks one sample: `alerts` are the thresholds that reached their streak and are out of cooldown; `active` the ones
	 * over threshold for at least the streak now, alerted or not (what a footer shows).
	 */
	observe(sample: MachineSample): { alerts: MachineAlert[]; active: Reading[] } {
		const t = this.#thresholds();
		const over = readings(sample, t);
		for (const rule of this.#streak.keys())
			if (!over.some((reading) => reading.rule === rule)) this.#streak.delete(rule);
		const alerts: MachineAlert[] = [];
		const active: Reading[] = [];
		for (const reading of over) {
			const streak = (this.#streak.get(reading.rule) ?? 0) + 1;
			this.#streak.set(reading.rule, streak);
			if (streak < t.samples) continue;
			active.push(reading);
			const last = this.#alertedAt.get(reading.rule);
			if (last !== undefined && sample.at - last < t.cooldownMinutes * 60_000) continue;
			this.#alertedAt.set(reading.rule, sample.at);
			alerts.push({ ...reading, at: sample.at, streak, ...causeOf(sample, reading.rule) });
		}
		return { alerts, active };
	}
}
