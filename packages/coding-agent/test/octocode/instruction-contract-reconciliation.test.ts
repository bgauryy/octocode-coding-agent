import { type Tool, validateToolArguments } from "@octocodeai/octocode-ai";
import { beforeAll, describe, expect, it } from "vitest";
import { renderPrompt } from "../../src/core/prompt-template.ts";
import { registerBacklogPlanTool } from "../../src/octocode/native/tools/backlog-plan/tool.ts";
import { forkNote, resumeNote, resumableChild } from "../../src/octocode/subagents/children.ts";
import { registerChildRunnerTask } from "../../src/octocode/subagents/runner-task.ts";
import { captureAll, type AgentContext } from "./agent-context/capture.ts";
import { fakeHost } from "./fake-host.ts";

let contexts: AgentContext[];
beforeAll(async () => {
	contexts = await captureAll();
}, 60_000);

describe("instructions agree with the tools their recipient receives", () => {
	it("names the public stop field accepted by the main agent schema", () => {
		const agent = contexts.find((context) => context.name === "main")!.tools.find((tool) => tool.name === "agent")!;
		const notice = renderPrompt("notices/subagents/lingering.md", {
			id: "child-example",
			seconds: 900,
			blocked: false,
			peer: false,
			parent: false,
			reachable: true,
			requests: 1,
			one: true,
			cost: "",
		});
		const field = notice.match(/`coordinate` action `stop` with `(\w+)` child-example/)?.[1];
		expect(field).toBe("subagent");
		expect(() =>
			validateToolArguments(agent as Tool, {
				type: "toolCall",
				id: "check",
				name: "agent",
				arguments: { type: "coordinate", action: "stop", [field!]: "child-example", reason: "Contract check only" },
			}),
		).not.toThrow();
	});

	it.each(["resume", "fork"])("does not recommend resuming an isolated child after %s", (kind) => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "isolated-call",
							name: "agent",
							arguments: { type: "task", isolate: true, background: true, task: "Read an isolated fixture" },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "isolated-call",
					toolName: "agent",
					content: [],
					details: {
						agentType: "task",
						id: "isolated-child",
						profile: "general",
						goal: "Review fixture",
						status: "background",
					},
				},
			},
		];
		const noticeFor = (list: unknown[]) =>
			kind === "resume" ? resumeNote(list, new Set(), new Set()) : forkNote(list);
		const notice = noticeFor(entries);
		// The notice names the child and its isolation, built from the recorded isolate flag.
		expect(notice).toContain("isolated-child");
		expect(notice).toContain("isolated, worktree isolated-child");
		// The same child recorded without `isolate` is described without an isolated worktree.
		const plain = structuredClone(entries);
		(plain[0] as any).message.content[0].arguments.isolate = false;
		const plainNotice = noticeFor(plain);
		expect(plainNotice).toContain("isolated-child");
		expect(plainNotice).not.toContain("isolated, worktree");
		expect(() => resumableChild(entries, "isolated-child", new Set())).toThrow(/isolated worktree/);
	});

	it("routes follow-ups to the coordinator when the child's planning tool is hidden", () => {
		const host = fakeHost();
		registerBacklogPlanTool(host.api, { isSubagent: true });
		expect(host.tools.get("backlogPlan").defaultActive).toBe(false);
		expect(
			contexts.find((context) => context.name === "general")!.tools.some((tool) => tool.name === "backlogPlan"),
		).toBe(false);
		const completion = renderPrompt("workflows/backlog/completion.md", {
			ref: "B1",
			goal: true,
			guidance: "Required completion fields",
		});
		expect(completion).toContain("B1");
		expect(completion).toContain("Required completion fields");
		expect(completion).not.toMatch(/\{\{|\}\}/);
		const withoutGoal = renderPrompt("workflows/backlog/completion.md", {
			ref: "B1",
			goal: false,
			guidance: "Required completion fields",
		});
		// The goal flag decides whether the goal section changes the rendered text.
		expect(withoutGoal).not.toBe(completion);
	});

	it("keeps the child agent tool from starting agents and the runner field from naming absent tools", () => {
		for (const child of contexts.filter((context) => context.kind === "child")) {
			const agent = child.tools.find((tool) => tool.name === "agent")!;
			const parameters = agent.parameters as { properties: Record<string, { description?: string }> };
			expect(child.tools.some((tool) => tool.name === "models")).toBe(false);
			expect(parameters.properties).not.toHaveProperty("profile");
			// A child cannot start agents: its `agent` tool offers no `task` type, which the main agent's tool does.
			const types = (agent.parameters as { properties: { type: { enum: string[] } } }).properties.type.enum;
			expect(types).not.toContain("task");
		}
		// The runner field a child gets once a runner is enabled: external agents are opt-in, so the capture above has
		// none, and the field is checked as the child would receive it.
		const fake = fakeHost();
		registerChildRunnerTask(
			{ ids: ["codex"], turn: async () => ({ text: "" }) },
			{ check: async () => ({ allowed: false }) },
			fake.api.tools.register,
		);
		const runner = (fake.tools.get("agent")!.parameters as { properties: Record<string, { description?: string }> })
			.properties.runner;
		// Every tool the runner description names is a tool the child receives.
		const declared = new Set(contexts.find((context) => context.kind === "child")!.tools.map((tool) => tool.name));
		const known = new Set(contexts.flatMap((context) => context.tools.map((tool) => tool.name)));
		const mentioned = [...(runner.description ?? "").matchAll(/`(\w+)`/g)]
			.map((match) => match[1])
			.filter((name) => known.has(name));
		for (const name of mentioned) expect(declared.has(name)).toBe(true);
	});
});
