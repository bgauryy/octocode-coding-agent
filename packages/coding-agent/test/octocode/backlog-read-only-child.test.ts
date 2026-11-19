import { describe, expect, it } from "vitest";
import { registerBacklogPlanTool } from "../../src/octocode/native/tools/backlog-plan/tool.ts";
import { registerBacklogTool } from "../../src/octocode/native/tools/backlog/tool.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { fakeHost } from "./fake-host.ts";

const CHILD = { OCTOCODE_SUBAGENT: "1", OCTOCODE_READ_ONLY: "1" };
const WRITER = { OCTOCODE_SUBAGENT: "1" };

function activeTools(env: NodeJS.ProcessEnv): string[] {
	const host = fakeHost();
	registerBacklogTool(host.api, { isSubagent: true, env });
	registerBacklogPlanTool(host.api, { isSubagent: true, env });
	return host.api.tools.getActive();
}

const refusal = (toolName: string, input: Record<string, unknown>) =>
	readOnlyRoleRefusal({ toolName, input }, process.cwd(), CHILD);

describe("a read-only child (researcher, reviewer) and the board", () => {
	it("declares the backlog tools that read the board", () => {
		expect(activeTools(CHILD)).toEqual(expect.arrayContaining(["backlog", "backlogPlan"]));
	});

	it("leaves a child that may write without them unless its task names an item", () => {
		expect(activeTools(WRITER)).toEqual([]);
	});

	it.each([
		["backlog", { op: "get", id: "B1" }],
		["backlogPlan", { op: "list", query: "docs" }],
	])("allows %s %j", (tool, input) => {
		expect(refusal(tool, input)).toBeUndefined();
	});

	it.each([
		["backlog", { op: "claim", id: "B1" }],
		["backlog", { op: "note", id: "B1", note: "x" }],
		["backlog", { op: "done", id: "B1" }],
		["backlog", {}],
		["backlogPlan", { op: "add", items: [] }],
		["backlogPlan", { op: "edit", items: [] }],
	])("refuses %s %j", (tool, input) => {
		expect(refusal(tool, input)).toContain("read-only role");
	});

	it("does not limit a child that is not read-only", () => {
		expect(readOnlyRoleRefusal({ toolName: "backlog", input: { op: "note" } }, process.cwd(), WRITER)).toBeUndefined();
	});
});
