import { expect, it } from "vitest";
import { Type } from "typebox";
import type { ToolDefinition } from "../../src/core/features/index.ts";
import { agentModes } from "../../src/octocode/agent-tool.ts";
import { renderAgentResult } from "../../src/octocode/subagents/render.ts";
import { fakeCtx, fakeHost, rendered, theme } from "./fake-host.ts";

function unified() {
	const modes = agentModes();
	const parameters = Type.Object({ goal: Type.String(), task: Type.String() });
	const mode: ToolDefinition<typeof parameters> = {
		name: "agent",
		label: "Task",
		description: "Task",
		parameters,
		execute: async (_id, args) => {
			throw new Error(`Refused ${args.task}`);
		},
		renderResult: renderAgentResult,
	};
	modes.collect(mode);
	const host = fakeHost();
	modes.register(host.api);
	return host.tools.get("agent")!;
}

it("renders every rejected batch entry without presenting unused defaults as one prompt", async () => {
	const tool = unified();
	const args = {
		type: "task",
		reason: "render refused entries",
		goal: "Inherited goal",
		task: "unused fallback brief",
		tasks: [{ task: "first brief" }, { goal: "Explicit goal", task: "second brief" }],
	};
	const failure = await tool.execute("batch", args, undefined, undefined, fakeCtx({ cwd: process.cwd() })).then(
		() => {
			throw new Error("Expected every rejected batch entry to throw");
		},
		(error: unknown) => error,
	);
	expect(failure).toBeInstanceOf(Error);
	const text = (failure as Error).message;
	const row = tool.renderResult({ content: [{ type: "text", text }] }, { expanded: true, isPartial: false }, theme, {
		args,
		expanded: true,
		isError: true,
		isPartial: false,
		executionStarted: true,
		state: {},
	});
	const output = rendered(row);
	expect(output).toContain("#1 error: Inherited goal");
	expect(output).toContain("#2 error: Explicit goal");
	expect(output).toContain("Refused first brief");
	expect(output).toContain("Refused second brief");
	expect(output).not.toContain("unused fallback brief");
});

it("keeps the single-task error prompt and output details", () => {
	const tool = unified();
	const args = { type: "task", goal: "Single goal", task: "single brief" };
	const row = tool.renderResult(
		{ content: [{ type: "text", text: "Refused single task\nAdditional detail" }] },
		{ expanded: true, isPartial: false },
		theme,
		{ args, expanded: true, isError: true, isPartial: false, executionStarted: true, state: {} },
	);
	const output = rendered(row);
	expect(output).toContain("Prompt");
	expect(output).toContain("single brief");
	expect(output).toContain("Additional detail");
});

it("still recognizes a batch from persisted result details when call arguments are unavailable", () => {
	const tool = unified();
	const row = tool.renderResult(
		{
			content: [{ type: "text", text: "#1 error: retained goal\nRefused first brief" }],
			details: { agentType: "task", batch: [{ goal: "retained goal", ok: false }] },
		},
		{ expanded: true, isPartial: false },
		theme,
		{ isError: true, isPartial: false, state: {} },
	);
	expect(rendered(row)).toContain("#1 error: retained goal");
});
