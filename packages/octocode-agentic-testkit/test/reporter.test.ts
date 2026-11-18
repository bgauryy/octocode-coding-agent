import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TestModule } from "vitest/node";
import { mockMcp } from "../src/mcp.ts";
import AgentReporter, { agentReport, formatAgentReport } from "../src/reporter.ts";
import { suiteMeta, type SuiteMeta } from "../src/suite-meta.ts";
import { Trace } from "../src/trace.ts";
import { searchTool } from "./helpers.ts";

/** One turn on which the mock executed `search` and a guard fired. */
function turn(): { trace: Trace; mcp: Record<string, ReturnType<typeof mockMcp>> } {
	const trace = new Trace();
	const docs = mockMcp({
		name: "docs",
		trace,
		tools: [searchTool, { ...searchTool, name: "fetch" }],
	});
	const ev = { agent: "main", span: "main" };
	trace.record({ kind: "model_tool_call", ...ev, name: "search", args: {} });
	trace.record({ kind: "tool_exec", ...ev, name: "search", server: "docs", args: {} });
	trace.record({ kind: "model_tool_call", ...ev, name: "Skill", args: { skill: "runbook" } });
	trace.record({ kind: "guard", ...ev, name: "fetch", data: { reason: "forbidden call fetch({})", by: "gateway" } });
	trace.requests.push({
		index: 0,
		agent: "main",
		span: "main",
		model: "m",
		stream: false,
		messages: [],
		tools: [],
		raw: {},
		canonical: "",
		hash: "",
		bytes: 0,
		costUsd: 0.25,
	});
	return { trace, mcp: { docs } };
}

function modules(rows: { name: string; state: string; meta: SuiteMeta | undefined }[]): TestModule[] {
	const tests = rows.map((r) => ({
		fullName: r.name,
		meta: () => ({ agentSuite: r.meta }),
		result: () => ({ state: r.state }),
	}));
	return [{ children: { allTests: () => tests.values() } } as unknown as TestModule];
}

describe("suite meta and the agent reporter", () => {
	const a = turn();
	const b = turn();
	const meta = suiteMeta({
		adapter: "reference",
		needed: 2,
		passes: 1,
		failures: [{ replica: 1, message: "boom" }],
		turns: [a.trace, b.trace],
		mcp: [a.mcp, b.mcp],
	});

	it("summarizes a test across runs", () => {
		expect(meta).toMatchObject({
			runs: 2,
			passes: 1,
			needed: 2,
			costUsd: 0.5,
			requests: 2,
			toolsAdvertised: ["docs.fetch", "docs.search"],
			toolsExecuted: ["docs.search"],
			modelTools: ["Skill", "search"],
			skills: ["runbook"],
			guards: ["forbidden call fetch({})", "forbidden call fetch({})"],
			trajectories: [
				["search", "Skill"],
				["search", "Skill"],
			],
		});
		expect(meta.interval[0]).toBeLessThan(0.5);
		expect(meta.interval[1]).toBeGreaterThan(0.5);
	});

	it("reports tool coverage over the advertised mock tools, and ignores tests without suite meta", () => {
		const report = agentReport(
			modules([
				{ name: "flow > turn 1", state: "failed", meta },
				{ name: "plain unit test", state: "passed", meta: undefined },
			]),
		);
		expect(report.totals).toEqual({
			tests: 1,
			costUsd: 0.5,
			toolCoverage: 0.5,
			neverExecuted: ["docs.fetch"],
			skills: ["runbook"],
			guards: 2,
		});
		const text = formatAgentReport(report);
		expect(text).toContain("✗ flow > turn 1  1/2 (95% CI");
		expect(text).toContain("50% of mock tools executed · never: docs.fetch");
		expect(text).toContain("spend: $0.5000");
	});

	it("writes the JSON report and prints the summary, and stays silent without suite tests", () => {
		const file = join(mkdtempSync(join(tmpdir(), "testkit-report-")), "report.json");
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			new AgentReporter({ outputFile: file }).onTestRunEnd(modules([{ name: "u", state: "passed", meta: undefined }]));
			expect(write).not.toHaveBeenCalled();
			new AgentReporter({ outputFile: file }).onTestRunEnd(modules([{ name: "flow", state: "passed", meta }]));
			expect(write).toHaveBeenCalledWith(expect.stringContaining("Agent behavior"));
		} finally {
			write.mockRestore();
		}
		expect(JSON.parse(readFileSync(file, "utf8")).totals.neverExecuted).toEqual(["docs.fetch"]);
	});
});
