import { expect, it } from "vitest";
import { Type } from "typebox";
import type { ToolDefinition } from "../../src/core/features/index.ts";
import { agentModes } from "../../src/octocode/native/tools/agent/tool.ts";
import { batchCallText } from "../../src/octocode/native/tools/agent/batch.ts";
import { sessionChildren } from "../../src/octocode/child-sessions/session-children.ts";
import { spendOf } from "../../src/octocode/shared/util.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

function usage(cost = 3) {
	return {
		input: 100,
		output: 50,
		cacheRead: 25,
		cacheWrite: 10,
		reasoning: 5,
		totalTokens: 185,
		cost: { input: 1, output: cost - 1, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

const taskParameters = Type.Object({
	goal: Type.String(),
	task: Type.String(),
	background: Type.Optional(Type.Boolean()),
});

function unified(execute: ToolDefinition<typeof taskParameters>["execute"]) {
	const modes = agentModes();
	modes.collect({
		name: "agent",
		label: "Task",
		description: "Task",
		parameters: taskParameters,
		execute,
	});
	const host = fakeHost();
	modes.register(host.api);
	const tool = host.tools.get("agent")!;
	const run = (args: Record<string, unknown>) =>
		tool.execute(
			"batch",
			{ type: "task", reason: "contract regression", ...args },
			undefined,
			undefined,
			fakeCtx({ cwd: process.cwd() }),
		);
	return { tool, run };
}

function result(id: string, goal: unknown, extra: Partial<Awaited<ReturnType<ToolDefinition["execute"]>>> = {}) {
	return {
		content: [{ type: "text" as const, text: "Child report" }],
		details: { id, goal, profile: "fixture", status: "done", outcome: "done" },
		...extra,
	};
}

it("preserves foreground batch spend and unpriced indication", async () => {
	const { run } = unified(async (id, args) =>
		result(id, args.goal, {
			usage: usage(args.task === "first" ? 3 : 7),
			details: {
				id,
				goal: args.goal,
				profile: "fixture",
				status: "done",
				outcome: "done",
				unpriced: args.task === "second",
			},
		}),
	);
	const actual = await run({
		tasks: [
			{ goal: "one", task: "first" },
			{ goal: "two", task: "second" },
		],
	});
	expect(actual.usage).toMatchObject({ input: 200, reasoning: 10, cost: { total: 10 } });
	expect(actual.details.unpriced).toBe(true);
	expect(spendOf({ role: "toolResult", ...actual })?.usage).toMatchObject({ cost: { total: 10 } });
});

it("preserves an explicit schema failure and still discovers the dispatched child", async () => {
	const { run } = unified(async (id, args) =>
		result(id, args.goal, {
			isError: true,
			usage: usage(),
			details: {
				id,
				goal: args.goal,
				profile: "fixture",
				status: "done",
				outcome: "done",
				structured: { status: "invalid" },
			},
		}),
	);
	const args = { tasks: [{ goal: "one", task: "invalid final schema" }] };
	const actual = await run(args);
	expect(actual.isError).toBe(true);
	expect(actual.details.batch[0]).toMatchObject({ ok: true, isError: true });
	expect(actual.content[0].text).not.toMatch(/#1 ok:/);
	const children = sessionChildren([
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "batch", name: "agent", arguments: { type: "task", ...args } }],
			},
		},
		{ type: "message", message: { role: "toolResult", toolName: "agent", toolCallId: "batch", ...actual } },
	]);
	expect(children.map((child) => child.id)).toEqual(["batch#1"]);
});

it("keeps spend and an error signal when one entry refuses and another finishes", async () => {
	const { run } = unified(async (id, args) => {
		if (args.task === "refused") throw new Error("Refused before launch");
		return result(id, args.goal, { usage: usage() });
	});
	const actual = await run({
		tasks: [
			{ goal: "no", task: "refused" },
			{ goal: "yes", task: "runs" },
		],
	});
	expect(actual.isError).toBe(true);
	expect(actual.details.batch.map((row: { ok: boolean }) => row.ok)).toEqual([false, true]);
	expect(actual.usage.cost.total).toBe(3);
});

it("adds no spend for background starts before their eventual reports", async () => {
	const { run } = unified(async (id, args) =>
		result(id, args.goal, {
			details: { id, goal: args.goal, profile: "fixture", status: "background" },
		}),
	);
	const actual = await run({
		background: true,
		tasks: [
			{ goal: "one", task: "runs" },
			{ goal: "two", task: "runs" },
		],
	});
	expect(actual.usage).toBeUndefined();
	expect(spendOf({ role: "toolResult", ...actual })).toBeUndefined();
	expect(spendOf({ role: "custom", details: { usage: usage() } })?.usage).toEqual(usage());
});

it("resolves inherited goals consistently in application and terminal displays", () => {
	const { tool } = unified(async () => result("unused", "unused"));
	const args = {
		type: "task",
		goal: "Shared objective",
		tasks: [{ task: "first" }, { goal: "Own objective", task: "second" }],
	};
	expect(tool.display({ args, status: "running" }).subjects).toEqual(["1. Shared objective", "2. Own objective"]);
	expect(batchCallText(args)).toContain("1. Shared objective");
});
