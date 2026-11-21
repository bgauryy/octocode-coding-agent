/**
 * Cost of the late-report poll (B114) against a temporary OCTOCODE_HOME: disk calls and CPU per take for an empty and a
 * populated pending folder, delivery latency through the real 1 s clock, and the scans a slow filesystem causes.
 *   node packages/coding-agent/scripts/bench-late-reports.ts
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.OCTOCODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bench-late-"));
const { pendingReportsDir, savePendingReport, takePendingReports, releasePendingReports } =
	await import("../src/octocode/subagents/handoff/pending.ts");
const { LateReports } = await import("../src/octocode/subagents/late.ts");

const report = (id: string) => ({
	content: `Background subagent ${id} finished ${"x".repeat(2000)}`,
	details: { id, status: "done" as const, summary: "Done" },
	wake: false,
});
const cpuMs = () => {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1000;
};
const load1 = () => os.loadavg()[0].toFixed(1);
const counted = ["readdir", "rename", "readFile", "writeFile", "rm", "open", "stat"] as const;
const calls: Record<string, number> = {};
for (const name of counted) {
	const original = (fsp as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name];
	(fsp as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
		calls[name] = (calls[name] ?? 0) + 1;
		return original.apply(fsp, args);
	};
}
const snapshot = () => ({ ...calls });
const diff = (before: Record<string, number>) =>
	Object.fromEntries(
		Object.entries(calls)
			.map(([k, v]) => [k, v - (before[k] ?? 0)])
			.filter(([, v]) => v),
	);
const out: Record<string, unknown>[] = [];
let n = 0;
const freshDir = () => pendingReportsDir(`bench-late-${process.pid}-${++n}`);

// 1. Cost per take: empty folder, then populated (each take claims, reads and — for the bench — releases every report).
for (const reports of [0, 1, 50, 500]) {
	const dir = freshDir();
	for (let i = 0; i < reports; i++) savePendingReport(dir, `r${i}`, report(`r${i}`));
	const takes = reports === 0 ? 500 : 1;
	const before = snapshot();
	const c0 = cpuMs();
	const t0 = performance.now();
	let got = 0;
	for (let i = 0; i < takes; i++) {
		const taken = await takePendingReports(dir);
		got += taken.length;
		await releasePendingReports(taken);
	}
	out.push({
		bench: "take",
		reportsOnDisk: reports,
		takes,
		delivered: got,
		cpuMsPerTake: +((cpuMs() - c0) / takes).toFixed(3),
		wallMsPerTake: +((performance.now() - t0) / takes).toFixed(3),
		diskCallsPerTake: Object.fromEntries(Object.entries(diff(before)).map(([k, v]) => [k, +(v / takes).toFixed(2)])),
	});
}

// 2. Real poll over its 20 s window: empty folder, then a report arrives at 5 s (delivery latency via the 1 s clock).
async function poll(label: string, readdirDelayMs: number) {
	const sessionId = `bench-late-${process.pid}-${++n}`;
	const dir = pendingReportsDir(sessionId);
	let delivered = 0;
	let savedAt = 0;
	let latency = -1;
	const runs = {
		reports: {
			pendingDir: undefined as string | undefined,
			add: () => {
				delivered++;
				latency = Date.now() - savedAt;
				return undefined;
			},
		},
	};
	const late = new LateReports(runs as never);
	const realReaddir = fsp.readdir;
	let inFlight = 0;
	let maxInFlight = 0;
	let scans = 0;
	(fsp as unknown as Record<string, unknown>).readdir = async (...args: unknown[]) => {
		scans++;
		maxInFlight = Math.max(maxInFlight, ++inFlight);
		if (readdirDelayMs) await new Promise((resolve) => setTimeout(resolve, readdirDelayMs));
		try {
			return await (realReaddir as (...a: unknown[]) => Promise<unknown>).apply(fsp, args);
		} finally {
			inFlight--;
		}
	};
	const before = snapshot();
	const c0 = cpuMs();
	await late.start(sessionId);
	setTimeout(() => {
		savedAt = Date.now();
		savePendingReport(dir, "late", report("late"));
	}, 5_000);
	await new Promise((resolve) => setTimeout(resolve, 21_000));
	late.stop();
	(fsp as unknown as Record<string, unknown>).readdir = realReaddir;
	out.push({
		bench: "poll",
		label,
		readdirDelayMs,
		windowMs: 20_000,
		readdirCalls: scans,
		maxConcurrentScans: maxInFlight,
		delivered,
		deliveryLatencyMs: latency,
		cpuMsOverWindow: +(cpuMs() - c0).toFixed(1),
		diskCalls: diff(before),
	});
}
await poll("fast disk", 0);
await poll("slow disk", 3_000);

for (const line of out) console.log(JSON.stringify({ ...line, load1: load1() }));
fs.rmSync(process.env.OCTOCODE_HOME, { recursive: true, force: true });
