import { sharedClock } from "@octocodeai/octocode-common/clock";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "@octocodeai/octocode-common/time";
import {
	type Db,
	isBusy,
	type MachineProcess,
	type MachineSample,
	machineSamples,
	withoutWaiting,
} from "../../../../db/src/api.ts";
import { readBusiest } from "./busiest.ts";
import { type MachineFigures, readMachine } from "./readers.ts";

/**
 * One Octocode process per machine samples it every minute (load, memory, swap, GPU and the busiest processes) into the
 * agent database: whoever holds the sampler lease. Every process, holder or not, hands each new sample to `onSample`, so
 * the threshold rules run everywhere on the same data while `ps`, `sysctl` and `ioreg` run once per machine. The holder
 * renews its lease each sample; when it exits it releases it, and when it dies the lease runs out and another process
 * takes over.
 */

const DEFAULT_MACHINE_SAMPLE_MS = MINUTE_MS;
/** Samples older than this are deleted by the holder, at most once an hour. */
export const MACHINE_SAMPLE_RETENTION_MS = DAY_MS;
const PRUNE_EVERY_MS = HOUR_MS;
/** A lease outlives two missed samples, so a holder busy for one tick keeps it. */
const LEASE_INTERVALS = 2.5;
/** The busiest processes kept per sample, by CPU and by memory each. */
const BUSIEST_LIMIT = 8;

export interface MachineSamplerOptions {
	db: Db;
	/** Names this process in the lease; unique per process (pid plus start time). */
	holder: string;
	intervalMs?: number;
	readFigures?: () => Promise<MachineFigures>;
	readProcesses?: () => Promise<MachineProcess[]>;
	now?: () => number;
	pid?: number;
	/** false: never takes the lease, only reads the holder's samples (a subagent: its parent's process samples). Default true. */
	takesSamples?: boolean;
	/** Each sample newer than the last one handed over; `own` when this process took it. */
	onSample: (sample: MachineSample, own: boolean) => void;
	/** A failed sample must not break the session: the caller decides what to do with the error. */
	onError: (error: unknown) => void;
}

export interface MachineSampler {
	/** Runs one tick now (the timer runs the others); settles when it is done. */
	tick(): Promise<void>;
	/** Clears the timer and gives the lease up, so another process can take over at once. */
	stop(): void;
}

/** Starts sampling at once and every `intervalMs` after; the timer never keeps the process alive. */
export function startMachineSampler(options: MachineSamplerOptions): MachineSampler {
	const now = options.now ?? Date.now;
	const intervalMs = options.intervalMs ?? DEFAULT_MACHINE_SAMPLE_MS;
	const readFigures = options.readFigures ?? (() => readMachine());
	const readProcesses = options.readProcesses ?? (() => readBusiest(BUSIEST_LIMIT));
	const pid = options.pid ?? process.pid;
	let lastSeen = 0;
	let lastPrune = 0;
	let running: Promise<void> | undefined;
	let stopped = false;

	const hand = (sample: MachineSample | undefined, own: boolean): void => {
		if (!sample || sample.at <= lastSeen) return;
		lastSeen = sample.at;
		options.onSample(sample, own);
	};

	const sampleOnce = async (): Promise<void> => {
		const holds =
			options.takesSamples !== false &&
			withoutWaiting(options.db, () =>
				machineSamples.acquire(options.db, options.holder, pid, now(), intervalMs * LEASE_INTERVALS),
			);
		if (!holds) {
			hand(
				withoutWaiting(options.db, () => machineSamples.latest(options.db)),
				false,
			);
			return;
		}
		const [figures, processes] = await Promise.all([readFigures(), readProcesses()]);
		// Stopped while the readers ran: the lease is released and must stay so.
		if (stopped) return;
		const sample: MachineSample = { at: now(), ...figures, processes };
		withoutWaiting(options.db, () => {
			machineSamples.record(options.db, sample);
			if (sample.at - lastPrune >= PRUNE_EVERY_MS) {
				machineSamples.pruneBefore(options.db, sample.at - MACHINE_SAMPLE_RETENTION_MS);
				lastPrune = sample.at;
			}
		});
		hand(sample, true);
	};

	const tick = (): Promise<void> => {
		if (stopped) return Promise.resolve();
		// A tick still reading (a slow `ps` on a loaded machine) covers this one.
		running ??= sampleOnce()
			.catch((error: unknown) => {
				// Another process holds the database: this sample is skipped, the next one is a minute away.
				if (!stopped && !isBusy(error)) options.onError(error);
			})
			.finally(() => {
				running = undefined;
			});
		return running;
	};

	void tick();
	const stopTimer = sharedClock.subscribe(() => void tick(), { everyMs: intervalMs });
	return {
		tick,
		stop() {
			if (stopped) return;
			stopped = true;
			stopTimer();
			try {
				machineSamples.release(options.db, options.holder);
			} catch (error) {
				// A busy database leaves the lease to run out, which hands it over a little later.
				if (!isBusy(error)) options.onError(error);
			}
		},
	};
}
