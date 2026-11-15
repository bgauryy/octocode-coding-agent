import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";

export interface RuntimeMetrics {
	elapsedMs: number;
	cpuPercent: number;
	heapUsedBytes: number;
	rssBytes: number;
	gcCount: number;
	gcDurationMs: number;
	maxGcDurationMs: number;
	eventLoopDelayP99Ms: number;
	maxEventLoopDelayMs: number;
}

/** Opt-in process counters. They cover Octocode, never the terminal emulator or its GPU. */
export class RenderRuntimeMetrics {
	private observer: PerformanceObserver | undefined;
	private delay: ReturnType<typeof monitorEventLoopDelay> | undefined;
	private startedAt = 0;
	private cpuStart = process.cpuUsage();
	private gcCount = 0;
	private gcDurationMs = 0;
	private maxGcDurationMs = 0;
	private last: RuntimeMetrics | undefined;

	setEnabled(enabled: boolean): void {
		if (enabled === (this.observer !== undefined)) return;
		if (!enabled) {
			this.record(this.observer!.takeRecords());
			this.last = this.snapshot();
			this.observer!.disconnect();
			this.delay?.disable();
			this.observer = undefined;
			this.delay = undefined;
			return;
		}
		this.startedAt = performance.now();
		this.cpuStart = process.cpuUsage();
		this.gcCount = 0;
		this.gcDurationMs = 0;
		this.maxGcDurationMs = 0;
		this.last = undefined;
		this.delay = monitorEventLoopDelay({ resolution: 20 });
		this.delay.enable();
		this.observer = new PerformanceObserver((list) => this.record(list.getEntries()));
		this.observer.observe({ entryTypes: ["gc"] });
	}

	private record(entries: readonly { duration: number; startTime: number }[]): void {
		for (const entry of entries) {
			if (entry.startTime < this.startedAt) continue;
			this.gcCount++;
			this.gcDurationMs += entry.duration;
			this.maxGcDurationMs = Math.max(this.maxGcDurationMs, entry.duration);
		}
	}

	snapshot(): RuntimeMetrics | undefined {
		if (!this.observer) return this.last;
		this.record(this.observer.takeRecords());
		const elapsedMs = performance.now() - this.startedAt;
		const cpu = process.cpuUsage(this.cpuStart);
		const memory = process.memoryUsage();
		const sampled = this.delay && this.delay.count > 0;
		return {
			elapsedMs,
			cpuPercent: elapsedMs > 0 ? (cpu.user + cpu.system) / (elapsedMs * 10) : 0,
			heapUsedBytes: memory.heapUsed,
			rssBytes: memory.rss,
			gcCount: this.gcCount,
			gcDurationMs: this.gcDurationMs,
			maxGcDurationMs: this.maxGcDurationMs,
			eventLoopDelayP99Ms: sampled ? this.delay!.percentile(99) / 1e6 : 0,
			maxEventLoopDelayMs: sampled ? this.delay!.max / 1e6 : 0,
		};
	}
}
