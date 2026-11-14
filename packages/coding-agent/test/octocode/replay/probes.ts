import fs from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";

/**
 * What a replay measures about the process itself while it runs: event-loop delay, heap, garbage collection, and on
 * request a CPU profile and a sampling heap profile through the inspector of this very process (no `--cpu-prof`
 * flag, which would not reach a test worker).
 */

const ms = (nanoseconds: number) => Math.round((nanoseconds / 1e6) * 10) / 10;

export interface LoopDelay {
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	maxMs: number;
}

export interface GcTotals {
	count: number;
	totalMs: number;
	maxMs: number;
	byKind: Record<string, { count: number; totalMs: number }>;
}

const GC_KINDS: Record<number, string> = {
	[constants.NODE_PERFORMANCE_GC_MINOR]: "minor",
	[constants.NODE_PERFORMANCE_GC_MAJOR]: "major",
	[constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
	[constants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
};

/** Starts the always-on probes; `stop` returns what they saw. */
export function startProbes() {
	const histogram = monitorEventLoopDelay({ resolution: 10 });
	histogram.enable();
	/** The same delay, reset at each turn: which turns blocked the loop. */
	const perTurn = monitorEventLoopDelay({ resolution: 10 });
	perTurn.enable();
	const gc: GcTotals = { count: 0, totalMs: 0, maxMs: 0, byKind: {} };
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			const kind = GC_KINDS[(entry as { detail?: { kind?: number } }).detail?.kind ?? -1] ?? "other";
			gc.count += 1;
			gc.totalMs += entry.duration;
			gc.maxMs = Math.max(gc.maxMs, entry.duration);
			const bucket = gc.byKind[kind] ?? { count: 0, totalMs: 0 };
			bucket.count += 1;
			bucket.totalMs += entry.duration;
			gc.byKind[kind] = bucket;
		}
	});
	observer.observe({ entryTypes: ["gc"] });
	let heapPeak = process.memoryUsage().heapUsed;
	let rssPeak = process.memoryUsage().rss;
	return {
		/** Samples the heap; called between turns (a sampler on a timer would add the delay it measures). */
		sampleHeap() {
			const usage = process.memoryUsage();
			heapPeak = Math.max(heapPeak, usage.heapUsed);
			rssPeak = Math.max(rssPeak, usage.rss);
		},
		/** Starts a turn's window; `turnEnded` returns the longest delay in it. */
		turnStarted() {
			perTurn.reset();
		},
		turnEnded: () => ms(perTurn.max),
		stop() {
			histogram.disable();
			perTurn.disable();
			observer.disconnect();
			const loop: LoopDelay = {
				p50Ms: ms(histogram.percentile(50)),
				p95Ms: ms(histogram.percentile(95)),
				p99Ms: ms(histogram.percentile(99)),
				maxMs: ms(histogram.max),
			};
			gc.totalMs = Math.round(gc.totalMs);
			gc.maxMs = Math.round(gc.maxMs * 10) / 10;
			for (const bucket of Object.values(gc.byKind)) bucket.totalMs = Math.round(bucket.totalMs);
			return { loop, gc, heapPeakBytes: heapPeak, rssPeakBytes: rssPeak };
		},
	};
}

/** Starts a CPU profile (and a sampling heap profile when `heap`) of this process; `stop` writes them to `dir`. */
export async function startProfile(dir: string, name: string, heap: boolean) {
	const session = new Session();
	session.connect();
	await session.post("Profiler.enable");
	// 250 µs: fine enough to see a 1 ms function, coarse enough to keep the profile of a long replay readable.
	await session.post("Profiler.setSamplingInterval", { interval: 250 });
	await session.post("Profiler.start");
	if (heap) {
		await session.post("HeapProfiler.enable");
		await session.post("HeapProfiler.startSampling", { samplingInterval: 64 * 1024 });
	}
	return async () => {
		fs.mkdirSync(dir, { recursive: true });
		const written: string[] = [];
		const { profile } = await session.post("Profiler.stop");
		const cpu = path.join(dir, `${name}.cpuprofile`);
		fs.writeFileSync(cpu, JSON.stringify(profile));
		written.push(cpu);
		if (heap) {
			const { profile: sampled } = await session.post("HeapProfiler.stopSampling");
			const file = path.join(dir, `${name}.heapprofile`);
			fs.writeFileSync(file, JSON.stringify(sampled));
			written.push(file);
		}
		session.disconnect();
		return written;
	};
}

/** p50, p95 and max of `values`, rounded to 0.1. */
export function spread(values: readonly number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number) =>
		sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
	const round = (value: number) => Math.round(value * 10) / 10;
	return { p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? 0) };
}
