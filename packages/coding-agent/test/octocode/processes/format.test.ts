import { describe, expect, it } from "vitest";
import { visibleWidth } from "@octocodeai/octocode-tui";
import type { ProcessEntry, ProcessReport } from "../../../src/octocode/processes/classify.ts";
import { formatReport } from "../../../src/octocode/processes/format.ts";
import { scopeToSession } from "../../../src/octocode/processes/scope.ts";

const entry = (pid: number, extra: Partial<ProcessEntry> = {}): ProcessEntry => ({
	pid,
	ppid: 1,
	started: "1",
	role: "main",
	id: `id${pid}`,
	title: `octocode-agent-main-id${pid}`,
	sessionId: null,
	rssKb: 460 * 1024,
	ageMs: 60_000,
	ownerPid: null,
	ownerAlive: undefined,
	children: [],
	self: false,
	apiId: "oc-7a517b",
	...extra,
});

const report: ProcessReport = {
	processes: [
		entry(2604, {
			self: true,
			children: [
				{
					pid: 2746,
					ppid: 2604,
					started: "1",
					kind: "mcp",
					label: "/opt/homebrew/Cellar/node/26.4.0/bin/node /Users/me/octocode/packages/octocode-mcp/dist/index.js",
					rssKb: 48 * 1024,
					ageMs: 60_000,
				},
			],
		}),
	],
	orphans: [
		{
			pid: 10339,
			started: "1",
			kind: "child",
			label: "/opt/homebrew/Cellar/node/26.4.0/bin/node /very/long/path/to/some/script.mjs",
			rssKb: 97 * 1024,
			ageMs: 19 * 60_000,
			ownerPid: 1,
			ownerLabel: "main-f9b2f386",
			reason: "owner-gone",
		},
	],
};

describe("/processes layout", () => {
	it("prints the full table when no width is given", () => {
		const lines = formatReport(report).split("\n");
		expect(lines[1]).toMatch(/^NAME +API +PID +PPID +OWNER +RSS +AGE$/);
		expect(lines[2]).toContain("oc-7a517b");
		expect(lines[2]).toContain("← this session");
	});

	it("keeps the full table at 100 columns, with every row inside it", () => {
		const text = formatReport(report, { width: 100 });
		for (const line of text.split("\n").filter((each) => /^(NAME|\S+ octocode-|    mcp|  pid)/.test(each)))
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		expect(text).toContain("OWNER");
	});

	it("is readable at 60 columns: no row wraps, the pid and memory stay whole, detail sits under the name", () => {
		const text = formatReport(report, { width: 60 });
		const lines = text.split("\n");
		const tableLines = lines.slice(1, lines.indexOf(""));
		expect(tableLines[0]).toMatch(/^NAME +PID +RSS +AGE$/);
		for (const line of tableLines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		expect(tableLines[1]).toMatch(/octocode-agent-main-id2604 +2604 +460 MB +1m$/);
		expect(tableLines[2]).toBe("    api oc-7a517b · ppid 1 · owner — · ← this session");
		const child = tableLines.find((line) => line.includes("mcp"))!;
		expect(child).toContain("pid 2746");
		expect(child).toContain("48 MB");
		expect(child).toContain("…");
		const orphan = lines.find((line) => line.startsWith("  pid 10339"))!;
		expect(visibleWidth(orphan)).toBeLessThanOrEqual(60);
		expect(orphan).toContain("…");
	});

	it("says how many processes of other sessions the listing leaves out", () => {
		expect(formatReport(report, { hidden: 3 })).toContain("3 processes of other sessions not shown: /processes all");
		expect(formatReport(report)).not.toContain("not shown");
	});
});

describe("/processes scope", () => {
	it("keeps this session and the subagents it started, however deep, and hides other sessions", () => {
		const all: ProcessReport = {
			processes: [
				entry(1, { self: true }),
				entry(2, { role: "implementer", ownerPid: 1 }),
				entry(3, { role: "researcher", ownerPid: 2 }),
				entry(4),
				entry(5, { role: "implementer", ownerPid: 4 }),
			],
			orphans: report.orphans,
		};
		const scoped = scopeToSession(all, 1);
		expect(scoped.report.processes.map((each) => each.pid)).toEqual([1, 2, 3]);
		expect(scoped.hidden).toBe(2);
		expect(scoped.report.orphans).toEqual(report.orphans);
	});

	it("does not loop on an owner cycle", () => {
		const cyclic: ProcessReport = {
			processes: [entry(1, { ownerPid: 2 }), entry(2, { ownerPid: 1 })],
			orphans: [],
		};
		expect(scopeToSession(cyclic, 9).report.processes).toEqual([]);
	});
});
