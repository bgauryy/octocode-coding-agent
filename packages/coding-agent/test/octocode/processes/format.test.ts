import { describe, expect, it } from "vitest";
import { visibleWidth } from "@octocodeai/octocode-tui";
import type { ProcessEntry, ProcessReport } from "../../../src/octocode/processes/classify.ts";
import { formatReport } from "../../../src/octocode/processes/format.ts";
import { scopeToWorkspace } from "../../../src/octocode/processes/scope.ts";

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
	cwd: null,
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

	it("names the web daemon's row without an agent mark and says what it is", () => {
		const daemon = entry(300, { role: "web", id: "300", title: "octocode-agent-web-300", apiId: undefined });
		const row = formatReport({ processes: [daemon], orphans: [] })
			.split("\n")
			.find((line) => line.includes("octocode-agent-web-300"))!;
		expect(row).toMatch(/^ {3}octocode-agent-web-300 /);
		expect(row).toContain("← web daemon for every session; /web stop ends it");
	});

	it("says how many processes of other sessions the listing leaves out", () => {
		expect(formatReport(report, { hidden: 3 })).toContain("3 processes outside this folder not shown: /processes all");
		expect(formatReport(report)).not.toContain("not shown");
	});
});

describe("/processes scope", () => {
	it("keeps processes under this folder, this process and the subagents of either, and hides the rest", () => {
		const all: ProcessReport = {
			processes: [
				entry(1, { self: true }),
				entry(2, { role: "implementer", ownerPid: 1, cwd: "/worktrees/elsewhere" }),
				entry(3, { role: "researcher", ownerPid: 2 }),
				entry(4, { cwd: "/work/app/packages/x" }),
				entry(5, { cwd: "/work/application" }),
				entry(6, { cwd: "/other" }),
				entry(7, { role: "implementer", ownerPid: 6 }),
				entry(8),
			],
			orphans: report.orphans,
		};
		const scoped = scopeToWorkspace(all, "/work/app", 1);
		expect(scoped.report.processes.map((each) => each.pid)).toEqual([1, 2, 3, 4]);
		expect(scoped.hidden).toBe(4);
		expect(scoped.report.orphans).toEqual(report.orphans);
	});

	it("lists the user-level web daemon in every folder: it serves every session there", () => {
		const daemon = entry(300, { role: "web", id: "300", title: "octocode-agent-web-300" });
		// A subagent that happens to be called `web` carries its agent id, not its pid: it stays with its owner's folder.
		const namesake = entry(301, { role: "web", id: "brisk-otter", title: "octocode-agent-web-brisk-otter" });
		const scoped = scopeToWorkspace({ processes: [entry(1, { self: true }), daemon, namesake], orphans: [] }, "/w", 1);
		expect(scoped.report.processes.map((each) => each.pid)).toEqual([1, 300]);
		expect(scoped.hidden).toBe(1);
	});

	it("does not loop on an owner cycle", () => {
		const cyclic: ProcessReport = {
			processes: [entry(1, { ownerPid: 2 }), entry(2, { ownerPid: 1 })],
			orphans: [],
		};
		expect(scopeToWorkspace(cyclic, "/w", 9).report.processes).toEqual([]);
	});

	it("cuts plain-text cells without escape codes", () => {
		const lines = formatReport(
			{ processes: [entry(1, { title: "octocode-agent-main-" + "x".repeat(80) })], orphans: [] },
			{ width: 40 },
		);
		expect(lines).not.toContain("\x1b");
	});
});
