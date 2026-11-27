import { describe, expect, it } from "vitest";
import type { ProcessSample } from "../../../../db/src/api.ts";
import { classifyProcesses, growthOf, ORPHAN_GRACE_MS } from "../../../src/octocode/processes/classify.ts";
import type { ProcessRow } from "../../../src/octocode/processes/table.ts";

const NOW = 10_000_000;
const MB = 1024 * 1024;
const row = (pid: number, ppid: number, started: string, command: string, rssKb = 1000): ProcessRow => ({
	pid,
	ppid,
	started,
	command,
	rssKb,
});
const child = (pid: number, ppid: number, started: string, kind = "mcp", rss = 10 * MB) => ({
	pid,
	ppid,
	started,
	kind,
	label: `child ${pid}`,
	rss,
});
const sample = (over: Partial<ProcessSample> & { pid: number; started: string }): ProcessSample => ({
	at: NOW - 60_000,
	ppid: 1,
	role: "main",
	title: "octocode-agent-main-aaaaaaaa",
	id: "aaaaaaaa",
	sessionId: null,
	agentId: null,
	ownerPid: null,
	ownerStarted: null,
	cwd: null,
	rss: 100 * MB,
	heapUsed: 40 * MB,
	ended: false,
	children: [],
	...over,
});

describe("classifyProcesses", () => {
	it("lists live processes with role, id, age, RSS and the children they own", () => {
		const table = [
			row(100, 50, "9000", "octocode-agent-main-aaaaaaaa", 2048),
			row(101, 100, "9100", "node /x/octocode-mcp/dist/index.js", 4096),
			row(102, 101, "9100", "/x/octocode mcp", 1024),
		];
		const samples = [
			sample({ pid: 100, started: "9000", children: [child(101, 100, "9100"), child(102, 101, "9100")] }),
		];
		const report = classifyProcesses({ table, samples, now: NOW, selfPid: 100 });
		expect(report.orphans).toEqual([]);
		expect(report.processes).toHaveLength(1);
		const [main] = report.processes;
		expect(main).toMatchObject({ pid: 100, ppid: 50, role: "main", id: "aaaaaaaa", rssKb: 2048, self: true });
		expect(main.ageMs).toBe(NOW - 9_000_000);
		expect(main.children.map((entry) => [entry.pid, entry.kind, entry.rssKb])).toEqual([
			[101, "mcp", 4096],
			[102, "mcp", 1024],
		]);
	});

	it("shows an octocode-titled process that has no sample yet, with the role and id its title names", () => {
		const table = [row(200, 1, "9500", "octocode-agent-reviewer-sneaky-starfish")];
		const [entry] = classifyProcesses({ table, samples: [], now: NOW }).processes;
		expect(entry).toMatchObject({ pid: 200, role: "reviewer", id: "sneaky-starfish" });
	});

	it("keeps subagents separate from their parent's children, with the parent as owner", () => {
		const table = [
			row(100, 50, "9000", "octocode-agent-main-aaaaaaaa"),
			row(110, 100, "9200", "octocode-agent-implementer-nifty-beak"),
		];
		const samples = [
			sample({ pid: 100, started: "9000" }),
			sample({ pid: 110, started: "9200", role: "implementer", id: "nifty-beak", ownerPid: 100, ownerStarted: "9000" }),
		];
		const report = classifyProcesses({ table, samples, now: NOW });
		const sub = report.processes.find((entry) => entry.pid === 110)!;
		expect(sub.ownerAlive).toBe(true);
		expect(report.processes.find((entry) => entry.pid === 100)!.children).toEqual([]);
		expect(report.orphans).toEqual([]);
	});

	it("never takes the web daemon for an orphan of the session that started it", () => {
		// The session recorded the detached daemon among its children, then exited; the daemon names itself, so it is listed.
		const table = [row(300, 1, "9300", "octocode-agent-web-300")];
		const samples = [
			sample({
				pid: 100,
				started: "9000",
				at: NOW - ORPHAN_GRACE_MS - 1,
				ended: true,
				children: [child(300, 100, "9300", "child")],
			}),
		];
		const report = classifyProcesses({ table, samples, now: NOW });
		expect(report.orphans).toEqual([]);
		expect(report.processes).toEqual([expect.objectContaining({ pid: 300, role: "web", id: "300" })]);
	});

	it("flags a child whose owner process is gone", () => {
		const table = [row(101, 1, "9100", "node /x/octocode-mcp/dist/index.js", 4096)];
		const samples = [sample({ pid: 100, started: "9000", children: [child(101, 100, "9100")] })];
		const { orphans, processes } = classifyProcesses({ table, samples, now: NOW });
		expect(processes).toEqual([]);
		expect(orphans).toHaveLength(1);
		expect(orphans[0]).toMatchObject({
			pid: 101,
			started: "9100",
			kind: "mcp",
			reason: "owner-gone",
			ownerPid: 100,
			rssKb: 4096,
		});
	});

	it("does not take a process that reused the owner's pid for the owner", () => {
		const table = [row(100, 1, "9999", "vim"), row(101, 100, "9100", "node server.js")];
		const samples = [sample({ pid: 100, started: "9000", children: [child(101, 100, "9100")] })];
		expect(classifyProcesses({ table, samples, now: NOW }).orphans.map((o) => o.pid)).toEqual([101]);
	});

	it("does not flag a pid that now belongs to a different process than the recorded child", () => {
		const table = [row(101, 1, "9777", "something else")];
		const samples = [sample({ pid: 100, started: "9000", children: [child(101, 100, "9100")] })];
		expect(classifyProcesses({ table, samples, now: NOW }).orphans).toEqual([]);
	});

	it("flags a child reparented to init while its owner lives", () => {
		const table = [row(100, 50, "9000", "octocode-agent-main-aaaaaaaa"), row(102, 1, "9100", "/x/octocode mcp")];
		const samples = [sample({ pid: 100, started: "9000", children: [child(102, 101, "9100")] })];
		const { orphans } = classifyProcesses({ table, samples, now: NOW });
		expect(orphans.map((o) => [o.pid, o.reason])).toEqual([[102, "reparented"]]);
	});

	it("leaves a child alone while its recorded parent still runs", () => {
		const table = [
			row(100, 50, "9000", "octocode-agent-main-aaaaaaaa"),
			row(101, 100, "9100", "node s.js"),
			row(102, 101, "9100", "native"),
		];
		const samples = [
			sample({ pid: 100, started: "9000", children: [child(101, 100, "9100"), child(102, 101, "9100")] }),
		];
		expect(classifyProcesses({ table, samples, now: NOW }).orphans).toEqual([]);
	});

	it("gives children of an owner that just shut down gracefully a grace period", () => {
		const table = [row(101, 1, "9100", "node s.js")];
		const ended = (at: number) =>
			sample({ pid: 100, started: "9000", ended: true, at, children: [child(101, 100, "9100")] });
		expect(classifyProcesses({ table, samples: [ended(NOW - 1000)], now: NOW }).orphans).toEqual([]);
		expect(classifyProcesses({ table, samples: [ended(NOW - ORPHAN_GRACE_MS - 1)], now: NOW }).orphans).toHaveLength(1);
	});

	it("flags a subagent whose parent Octocode is gone", () => {
		const table = [row(110, 1, "9200", "octocode-agent-implementer-nifty-beak")];
		const samples = [
			sample({ pid: 110, started: "9200", role: "implementer", id: "nifty-beak", ownerPid: 100, ownerStarted: "9000" }),
		];
		const { orphans, processes } = classifyProcesses({ table, samples, now: NOW });
		expect(processes[0].ownerAlive).toBe(false);
		expect(orphans.map((o) => [o.pid, o.kind, o.reason])).toEqual([[110, "subagent", "owner-gone"]]);
	});

	it("gives a subagent that just ended and whose parent is gone a grace period before it counts as an orphan", () => {
		const table = [row(110, 1, "9200", "octocode-agent-implementer-nifty-beak")];
		const ended = (at: number) =>
			sample({
				pid: 110,
				started: "9200",
				role: "implementer",
				id: "nifty-beak",
				ownerPid: 100,
				ownerStarted: "9000",
				ended: true,
				at,
			});
		expect(classifyProcesses({ table, samples: [ended(NOW - 1000)], now: NOW }).orphans).toEqual([]);
		expect(classifyProcesses({ table, samples: [ended(NOW - ORPHAN_GRACE_MS - 1)], now: NOW }).orphans).toHaveLength(1);
	});

	it("shows a process still named octocode-agent-main or octocode-agent-rpc, before its session id exists", () => {
		const table = [row(300, 50, "9500", "octocode-agent-main"), row(301, 50, "9501", "octocode-agent-rpc --mode rpc")];
		const { processes } = classifyProcesses({ table, samples: [], now: NOW });
		expect(processes.map((entry) => [entry.pid, entry.role])).toEqual([
			[300, "main"],
			[301, "rpc"],
		]);
	});

	it("never flags a child without a recorded start time", () => {
		const table = [row(101, 1, "9100", "node s.js")];
		const samples = [sample({ pid: 100, started: "9000", children: [{ ...child(101, 100, "9100"), started: null }] })];
		expect(classifyProcesses({ table, samples, now: NOW }).orphans).toEqual([]);
	});

	it("uses only the newest sample of each process for its children", () => {
		const table = [row(101, 1, "9100", "node s.js")];
		const samples = [
			sample({ pid: 100, started: "9000", at: NOW - 600_000, children: [child(101, 100, "9100")] }),
			sample({ pid: 100, started: "9000", at: NOW - 300_000, children: [] }),
		];
		expect(classifyProcesses({ table, samples, now: NOW }).orphans).toEqual([]);
	});
});

describe("memory growth", () => {
	const series = (...mb: number[]) => mb.map((value, i) => ({ at: i * 5 * 60_000, rss: value * MB }));

	it("flags steadily rising memory over enough samples", () => {
		expect(growthOf(series(100, 130, 170, 220, 260))).toEqual({ from: 100 * MB, to: 260 * MB, spanMs: 20 * 60_000 });
	});

	it("ignores a plateau, a dip, too few samples and small rises", () => {
		expect(growthOf(series(100, 101, 100, 102, 101))).toBeUndefined();
		expect(growthOf(series(100, 300, 150, 310, 320))).toBeUndefined();
		expect(growthOf(series(100, 200, 300))).toBeUndefined();
		expect(growthOf(series(10, 12, 14, 16, 20))).toBeUndefined();
	});

	it("reports growth on a live process and on a child, from the owner's samples", () => {
		const table = [row(100, 50, "9000", "octocode-agent-main-aaaaaaaa"), row(101, 100, "9100", "node s.js")];
		const samples = [100, 130, 170, 220, 260].map((mb, i) =>
			sample({
				pid: 100,
				started: "9000",
				at: NOW - (4 - i) * 5 * 60_000,
				rss: mb * MB,
				children: [child(101, 100, "9100", "mcp", mb * MB)],
			}),
		);
		const [entry] = classifyProcesses({ table, samples, now: NOW }).processes;
		expect(entry.growth).toMatchObject({ from: 100 * MB, to: 260 * MB });
		expect(entry.children[0].growth).toMatchObject({ from: 100 * MB, to: 260 * MB });
	});
});
