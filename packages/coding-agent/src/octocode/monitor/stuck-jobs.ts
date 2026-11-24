import { statSync } from "node:fs";
import { type PsSnapshot, readPsSnapshot } from "../shared/ps-snapshot.ts";

/** A background bash job as the monitor sees it. */
export interface WatchedJob {
	id: string;
	pid: number;
	log: string;
	startedAt: number;
	command: string;
}

export interface StuckJob extends WatchedJob {
	/** Milliseconds since its log last grew (or since it started). */
	silentMs: number;
	/** CPU of its process group, percent of one core. */
	cpu: number;
}

/** A job using less than this share of one core is idle. */
const IDLE_CPU = 1;

export interface StuckJobDeps {
	logSize: (file: string) => number | undefined;
	/** CPU per process group id; a job's process group id is its pid (it runs in its own group). */
	groupCpu: () => Promise<Map<number, number>>;
}

const liveDeps = (table: () => Promise<PsSnapshot | undefined> = readPsSnapshot): StuckJobDeps => ({
	logSize: (file) => {
		try {
			return statSync(file).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	},
	groupCpu: async () => {
		const cpu = new Map<number, number>();
		for (const row of (await table())?.rows.values() ?? []) cpu.set(row.pgid, (cpu.get(row.pgid) ?? 0) + row.cpu);
		return cpu;
	},
});

/**
 * Finds this session's background jobs that wrote nothing and used almost no CPU for `minutes`: waiting on input, a lock
 * or a dead peer. Each job is reported once; `ps` runs only when some job has been silent long enough.
 */
export class StuckJobWatch {
	readonly #deps: StuckJobDeps;
	readonly #seen = new Map<string, { size: number | undefined; changedAt: number }>();
	readonly #reported = new Set<string>();

	constructor(deps: StuckJobDeps = liveDeps()) {
		this.#deps = deps;
	}

	async check(jobs: readonly WatchedJob[], now: number, minutes: number): Promise<StuckJob[]> {
		const live = new Set(jobs.map((job) => job.id));
		for (const id of this.#seen.keys()) if (!live.has(id)) this.#seen.delete(id);
		for (const id of this.#reported) if (!live.has(id)) this.#reported.delete(id);
		if (minutes <= 0) return [];
		const silent: Array<WatchedJob & { silentMs: number }> = [];
		for (const job of jobs) {
			const size = this.#deps.logSize(job.log);
			const seen = this.#seen.get(job.id);
			const changedAt = !seen ? job.startedAt : seen.size !== size ? now : seen.changedAt;
			this.#seen.set(job.id, { size, changedAt });
			if (size !== seen?.size && seen) this.#reported.delete(job.id); // wrote again: may be reported again later
			if (!this.#reported.has(job.id) && now - changedAt >= minutes * 60_000)
				silent.push({ ...job, silentMs: now - changedAt });
		}
		if (silent.length === 0) return [];
		const cpu = await this.#deps.groupCpu();
		const stuck = silent.map((job) => ({ ...job, cpu: cpu.get(job.pid) ?? 0 })).filter((job) => job.cpu < IDLE_CPU);
		for (const job of stuck) this.#reported.add(job.id);
		return stuck;
	}
}
