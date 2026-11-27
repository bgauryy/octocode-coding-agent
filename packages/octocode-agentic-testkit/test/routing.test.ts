import { describe, expect, it } from "vitest";
import { referenceAdapter } from "../src/adapters/reference/index.ts";
import type { ResponderContext, Step } from "../src/gateway.ts";
import { passAtK, passHatK, wilson } from "../src/live.ts";
import { skillLoads } from "../src/matchers/skills.ts";
import { mockMcp, type ToolDef } from "../src/mcp.ts";
import { firstChoice, probeRouting } from "../src/routing.ts";
import { textOf, Trace } from "../src/trace.ts";
import { gateway, searchTool } from "./helpers.ts";

const deleteTool: ToolDef = {
	name: "delete_repo",
	description: "Delete a repository permanently",
	inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
};

/** A stand-in model that routes by the user's words. */
function router({ request }: ResponderContext): Step {
	const prompt = textOf(request.messages.findLast((m) => m.role === "user")?.content);
	if (/delete/.test(prompt)) return { toolCalls: [{ name: "delete_repo", args: { repo: "a/b" } }] };
	if (/runbook/.test(prompt)) return { toolCalls: [{ name: "Skill", args: { skill: "runbook" } }] };
	if (/find/.test(prompt)) return { toolCalls: [{ name: "search", args: { query: prompt } }] };
	return { text: "4" };
}

describe("probeRouting", () => {
	it("records each first choice without executing it, with accuracy and a confusion matrix", async () => {
		const mocks: ReturnType<typeof mockMcp>[] = [];
		const report = await probeRouting(
			[
				{ prompt: "find the retry docs", expect: "search" },
				{ prompt: "follow the runbook", expect: "skill:runbook" },
				{ prompt: "what is 2+2", expect: null },
				{ prompt: "delete the old repo", expect: "search" },
			],
			async (prompt, guards) => {
				const gw = await gateway({ responder: router, guards });
				const docs = mockMcp({ name: "docs", tools: [searchTool, deleteTool], trace: gw.trace, guards });
				mocks.push(docs);
				const session = await referenceAdapter({ trace: gw.trace, mcp: [docs.client()] }).start({
					gatewayUrl: gw.url,
				});
				await session.run(prompt);
				await session.close();
				await docs.close();
				return gw.trace;
			},
		);
		expect(report.results.map((r) => [r.chose, r.correct])).toEqual([
			["search", true],
			["skill:runbook", true],
			[null, true],
			["delete_repo", false],
		]);
		expect(report.accuracy).toBe(0.75);
		expect(report.confusion).toEqual({
			search: { search: 1, delete_repo: 1 },
			"skill:runbook": { "skill:runbook": 1 },
			"(none)": { "(none)": 1 },
		});
		for (const m of mocks) {
			expect(m.tool("search")).not.toHaveBeenCalled();
			expect(m.tool("delete_repo")).not.toHaveBeenCalled();
		}
	});

	it("matches the expected tool as a pattern", async () => {
		const report = await probeRouting([{ prompt: "find it", expect: /^mcp__docs__/ }], async () => {
			const t = new Trace();
			t.record({ kind: "model_tool_call", agent: "main", span: "main", name: "mcp__docs__search", args: {} });
			return t;
		});
		expect(report.results[0]).toMatchObject({ chose: "mcp__docs__search", correct: true, expected: "/^mcp__docs__/" });
	});
});

describe("skill detection shared by the reporter and the probe", () => {
	const t = new Trace();
	const rec = (name: string, args: unknown) =>
		t.record({ kind: "model_tool_call", agent: "main", span: "main", name, args });
	rec("Skill", { skill: "runbook" });
	rec("read", { path: "/home/u/.agents/skills/octo-review/SKILL.md" });
	rec("bash", { command: "ls" });
	t.record({ kind: "skill_load", agent: "main", span: "main", name: "planner" });

	it("names every loaded skill once, in order", () => {
		expect(skillLoads(t)).toEqual(["runbook", "octo-review", "planner"]);
		expect(firstChoice(t)).toBe("skill:runbook");
	});
});

describe("pass statistics", () => {
	it("passAtK is the unbiased pass@k and validates like passHatK", () => {
		expect(passAtK(10, 3, 1)).toBeCloseTo(0.3);
		expect(passAtK(5, 1, 5)).toBe(1);
		expect(passAtK(5, 0, 2)).toBe(0);
		expect(passAtK(4, 2, 2)).toBeCloseTo(1 - 1 / 6);
		expect(passHatK(4, 2, 2)).toBeCloseTo(1 / 6);
		expect(() => passAtK(3, 1, 4)).toThrow(RangeError);
	});

	it("wilson gives the honest range at small n", () => {
		const [lo, hi] = wilson(2, 2);
		expect(lo).toBeCloseTo(0.342, 2);
		expect(hi).toBe(1);
		expect(wilson(0, 0)).toEqual([0, 1]);
		const [l5, h5] = wilson(4, 5);
		expect(l5).toBeGreaterThan(0.3);
		expect(h5).toBeLessThan(1);
	});
});
