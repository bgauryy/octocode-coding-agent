import { describe, expect, it } from "vitest";
import { planAccepted, planParameters } from "../../src/octocode/backlog/plan-schema.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { leanTools, withBacklogTool } from "../../src/octocode/subagents/profile-tools.ts";
import { refuseLeanItem } from "../../src/octocode/subagents/second-child.ts";

const session = { id: "c1", dir: "/tmp/octo-child" };
const toolsArg = (args: string[]) => args[args.indexOf("--tools") + 1].split(",");

describe("a child started for an item can use backlog", () => {
	it("refuses an item for a lean child and never grants it backlog", () => {
		const lean = { name: "small", lean: true as const, tools: leanTools("small", "bash,file,web,agent") };
		expect(() => refuseLeanItem(lean, { ref: "B1" })).toThrow(/keep B1 yourself/);
		expect(() => refuseLeanItem(lean, undefined)).not.toThrow();
		expect(() => refuseLeanItem({ name: "g" } as never, { ref: "B1" })).not.toThrow();
		const kept = withBacklogTool(lean);
		expect(toolsArg(buildAgentArgs(kept as never, undefined, session))).not.toContain("backlog");
	});

	it("adds it to an absolute allowlist once, and leaves relative lists, no list and a named one alone", () => {
		const allow = { name: "a", tools: "read,file" };
		expect(withBacklogTool(allow).tools).toBe("read,file,backlog");
		expect(withBacklogTool(withBacklogTool(allow)).tools).toBe("read,file,backlog");
		const relative = { name: "r", tools: "+web" };
		expect(withBacklogTool(relative)).toBe(relative);
		const none = { name: "n" };
		expect(withBacklogTool(none)).toBe(none);
		expect(withBacklogTool(undefined)).toBeUndefined();
	});
});

describe("backlogPlan list declares its ready filter", () => {
	it("declares blocked, so a model can ask for the items with no open prerequisite", () => {
		const declared = planParameters("ops").properties as Record<string, unknown>;
		expect(declared.blocked).toBeDefined();
		expect((planAccepted(planParameters("ops")).properties as Record<string, unknown>).blocked).toBeDefined();
	});
});
