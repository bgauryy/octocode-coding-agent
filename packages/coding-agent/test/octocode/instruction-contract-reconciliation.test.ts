import { type Tool, validateToolArguments } from "@octocodeai/octocode-ai";
import { beforeAll, describe, expect, it } from "vitest";
import { renderInstruction } from "../../src/core/prompt-template.ts";
import { registerBacklogPlanTool } from "../../src/octocode/backlog/plan-tool.ts";
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
		const notice = renderInstruction("notices/subagents/lingering.md", {
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
		const notice = kind === "resume" ? resumeNote(entries, new Set(), new Set()) : forkNote(entries);
		expect(notice).toContain("non-isolated child");
		expect(notice).toContain("For an isolated child, start a new task");
		expect(() => resumableChild(entries, "isolated-child", new Set())).toThrow(/isolated worktree/);
	});

	it("routes follow-ups to the coordinator when the child's planning tool is hidden", () => {
		const host = fakeHost();
		registerBacklogPlanTool(host.api, { isSubagent: true });
		expect(host.tools.get("backlogPlan").defaultActive).toBe(false);
		expect(
			contexts.find((context) => context.name === "general")!.tools.some((tool) => tool.name === "backlogPlan"),
		).toBe(false);
		const completion = renderInstruction("workflows/backlog/completion.md", {
			ref: "B1",
			goal: true,
			guidance: "Required completion fields",
		});
		expect(completion).toContain("if it is available; otherwise report them to your coordinator to file");
		expect(completion).toContain("from: B1");
		expect(completion).toContain("Mark it done only after verifying its goal");
	});

	it("distinguishes vendor runner tasks from native children without referring to an absent models tool", () => {
		for (const child of contexts.filter((context) => context.kind === "child")) {
			const agent = child.tools.find((tool) => tool.name === "agent")!;
			const parameters = agent.parameters as { properties: Record<string, { description?: string }> };
			expect(child.tools.some((tool) => tool.name === "models")).toBe(false);
			expect(parameters.properties).not.toHaveProperty("profile");
			const policy = child.sections.map((section) => section.text).join("\n");
			expect(policy).not.toContain("You cannot start agents.");
			if (child.name !== "lean") expect(policy).toContain("You cannot start native Octocode subagents");
		}
		// The runner field a child gets once a runner is enabled: external agents are opt-in, so the capture above has
		// none, and the field is checked as the child would receive it.
		const fake = fakeHost();
		registerChildRunnerTask(
			{ ids: ["codex"], turn: async () => ({ text: "" }) },
			{ check: async () => ({ allowed: false }) },
			fake.api.registerTool,
		);
		const runner = (fake.tools.get("agent")!.parameters as { properties: Record<string, { description?: string }> })
			.properties.runner;
		expect(runner.description).not.toContain("see models");
		expect(runner.description).toContain("coordinator");
	});
});
