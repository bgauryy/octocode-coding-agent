/**
 * Central timing instrumentation for startup profiling.
 * Enable with OCTOCODE_TIMING=1 environment variable.
 */

const ENABLED = process.env.OCTOCODE_TIMING === "1";
interface TimingNamespace {
	/** `cpuMs`: user and system CPU this process spent in the phase. */
	timings: Array<{ label: string; ms: number; cpuMs: number }>;
	lastTime: number;
	lastCpu: NodeJS.CpuUsage;
}

type TimingLabel = "main" | "features";

const timingNamespaces = new Map<TimingLabel, TimingNamespace>();

export function resetTimings(namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	timingNamespaces.set(namespace, { timings: [], lastTime: Date.now(), lastCpu: process.cpuUsage() });
}

export function time(label: string, namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	const now = Date.now();

	if (!timingNamespaces.has(namespace)) {
		resetTimings(namespace);
	}

	const timingNamespace = timingNamespaces.get(namespace)!;
	const cpu = process.cpuUsage(timingNamespace.lastCpu);
	timingNamespace.timings.push({
		label,
		ms: now - timingNamespace.lastTime,
		cpuMs: Math.round((cpu.user + cpu.system) / 1000),
	});
	timingNamespace.lastTime = now;
	timingNamespace.lastCpu = process.cpuUsage();
}

function printTimingGroup(title: string, timings: TimingNamespace["timings"]): void {
	const printableTimings = timings.filter((timing) => timing.ms >= 0);
	if (printableTimings.length === 0) return;
	console.error(`\n--- ${title} ---`);
	for (const t of printableTimings) {
		console.error(`  ${t.label}: ${t.ms}ms (cpu ${t.cpuMs}ms)`);
	}
	const total = (key: "ms" | "cpuMs") => printableTimings.reduce((sum, timing) => sum + timing[key], 0);
	console.error(`  TOTAL: ${total("ms")}ms (cpu ${total("cpuMs")}ms)`);
	console.error(`${"-".repeat(title.length + 8)}\n`);
}

export function printTimings(): void {
	if (!ENABLED) return;
	for (const [namespace, timingNamespace] of timingNamespaces) {
		printTimingGroup(`Startup Timings: ${namespace}`, timingNamespace.timings);
	}
}
