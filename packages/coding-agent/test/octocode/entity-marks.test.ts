import { describe, expect, it } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { visibleWidth } from "@octocodeai/octocode-tui";
import type { ProcessEntry } from "../../src/octocode/processes/classify.ts";
import { formatReport } from "../../src/octocode/processes/format.ts";
import { ENTITY, entityOfRole } from "../../src/octocode/shared/entity.ts";
import { widgetLines } from "../../src/octocode/team/panel.ts";
import { theme } from "./fake-host.ts";

const NOW = 1_000_000;

const entry = (role: string, id: string, extra: Partial<ProcessEntry> = {}): ProcessEntry => ({
	pid: 100,
	ppid: 1,
	started: "1",
	role,
	id,
	title: `octocode-agent-${role}-${id}`,
	sessionId: null,
	rssKb: 1024,
	ageMs: 60_000,
	ownerPid: null,
	ownerAlive: undefined,
	children: [],
	self: false,
	...extra,
});

const member = (id: string, extra: Partial<Member> = {}): Member =>
	({
		id,
		role: "general",
		status: "working",
		joinedAt: NOW - 60_000,
		updatedAt: NOW,
		toolCalls: 2,
		input: 0,
		cacheRead: 0,
		output: 0,
		cost: 0,
		unpriced: false,
		goal: "Check timeout handling",
		...extra,
	}) as Member;

describe("entity marks", () => {
	it("marks main, RPC and ACP sessions as the main agent and every other role as a subagent", () => {
		for (const role of ["main", "rpc", "acp"]) expect(entityOfRole(role)).toBe(ENTITY.main);
		for (const role of ["researcher", "general", "agent"]) expect(entityOfRole(role)).toBe(ENTITY.subagent);
	});

	it("names each /processes row after its entity, with the columns still aligned", () => {
		const lines = formatReport({
			processes: [
				entry("main", "0de16b7a", { self: true }),
				entry("researcher", "inky", { ownerPid: 100 }),
				entry("implementer", "a-very-long-subagent-name-0001", { ownerPid: 100 }),
			],
			orphans: [],
		}).split("\n");
		const main = lines.find((line) => line.includes("octocode-agent-main-0de16b7a"))!;
		const sub = lines.find((line) => line.includes("octocode-agent-researcher-inky"))!;
		expect(main.startsWith(`${ENTITY.main} octocode-agent-main-0de16b7a`)).toBe(true);
		expect(sub.startsWith(`${ENTITY.subagent} octocode-agent-researcher-inky`)).toBe(true);
		const header = lines.find((line) => line.startsWith("NAME"))!;
		const column = (line: string, text: string) => visibleWidth(line.slice(0, line.indexOf(text)));
		expect(column(main, "off")).toBe(column(header, "API"));
		expect(column(sub, "off")).toBe(column(header, "API"));
		const long = lines.find((line) => line.includes("a-very-long-subagent-name-0001"))!;
		expect(column(long, "off")).toBe(column(header, "API"));
	});

	it("roots the panel at the main agent and never marks subagent rows: the tree says child", () => {
		const team = [
			member("main-aaaaaa", { role: "main", status: "idle" }),
			member("busy-aaaa", { parentId: "main-aaaaaa" }),
		];
		const wide = widgetLines(team, "main-aaaaaa", NOW, theme, 120);
		expect(wide[0].startsWith(` ${ENTITY.main} main-aaaaaa`)).toBe(true);
		expect(wide[0]).not.toMatch(/main-aaaaaa +main\b/);
		expect(wide[1]).toMatch(/^ └ ⏺ busy-aaaa +· /);
		for (const width of [200, 120, 119, 80, 40]) {
			const lines = widgetLines(team, "main-aaaaaa", NOW, theme, width);
			expect(lines[0]).toContain(ENTITY.main);
			expect(lines.slice(1).join("\n")).not.toContain(ENTITY.subagent);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps the space before the activity when a cut goal and a cut activity share the row", () => {
		const team = [
			member("main-aaaaaa", { role: "main", status: "idle" }),
			member("busy-aaaa", {
				parentId: "main-aaaaaa",
				goal: "Find where tools register in every package",
				activity: "localSearch registerTool across the workspace packages",
			}),
		];
		for (let width = 60; width <= 130; width++) {
			const row = widgetLines(team, "main-aaaaaa", NOW, theme, width)[1];
			expect(row, `${width}`).not.toContain("…›");
		}
	});
});
