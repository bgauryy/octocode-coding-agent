import fs from "node:fs";
import path from "node:path";
import {
	createAssistantMessageEventStream,
	type Model,
	type AssistantMessage,
	type Message,
	type JsonObject,
} from "@octocodeai/octocode-ai";
import { createEmptyUsage } from "../../../ai/src/utils/assistant-message.ts";
import { type AgentEvent, type AgentTool } from "@octocodeai/octocode-agent-core";
import { agentLoop } from "../../../agent/src/agent-loop.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { workspaceDb } from "../../src/storage/workspace-database.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { registerBacklogPlanTool } from "../../src/octocode/native/tools/backlog-plan/tool.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let root: string;
const model: Model<"openai-responses"> = {
	id: "scripted",
	name: "Scripted",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};
beforeEach(() => {
	root = tmp("octocode-batch-cancel-");
});
afterEach(() => {
	closeSharedAgentDb();
	vi.restoreAllMocks();
});

function fixture(changed = vi.fn(), fullRegistration = false) {
	const env = {
		...process.env,
		HOME: path.join(root, "home"),
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "agent.db"),
	};
	const cwd = path.join(root, "repo");
	fs.mkdirSync(cwd);
	const ctx = fakeCtx({ cwd, hasUI: fullRegistration });
	const fake = fakeHost();
	const options = { commands: new Subcommands(), isSubagent: false, env, changed };
	if (fullRegistration) registerBacklog(fake.api, options);
	else registerBacklogPlanTool(fake.api, options);
	const store = openBacklog(ctx, options).store;
	const agent = workspaceDb(cwd, env).agent;
	const tool = fake.tools.get("backlogPlan");
	return { ctx, tool, store, agent, changed };
}

it.each(["sequential", "parallel"] as const)(
	"warns about committed effects when a post-hook throws in the actual %s loop, preserving redaction",
	async (mode) => {
		for (const behavior of ["throw", "redact"] as const) {
			const { ctx, tool, store, agent, changed } = fixture();
			const controller = new AbortController();
			const unsubscribe = agent.onCommit(() => {
				if (store.list().total === 1) controller.abort();
			});
			const args: JsonObject = {
				op: "add",
				reason: "fixture",
				items: [
					{ title: "" },
					{ title: "First", why: "fixture", goal: "fixture" },
					{ title: "Unattempted", why: "fixture", goal: "fixture" },
				],
			};
			const adapted: AgentTool = {
				...tool,
				execute: (id, params, signal, update) => tool.execute(id, params, signal, update, ctx),
			};
			let requests = 0;
			const stream = agentLoop(
				[{ role: "user", content: "fixture", timestamp: Date.now() }],
				{ messages: [], tools: [adapted] },
				{
					model,
					toolExecution: mode,
					convertToLlm: (messages) => messages as Message[],
					afterToolCall: async ({ result }) => {
						expect(result.details).toMatchObject({ applied: 1, refused: 1, notAttempted: 1 });
						if (behavior === "throw") throw new Error("POST_HOOK_FAILURE");
						return { content: [{ type: "text", text: "REDACTED_RESULT" }], details: { redacted: true }, isError: true };
					},
				},
				controller.signal,
				() => {
					const output = createAssistantMessageEventStream();
					queueMicrotask(() => {
						const message: AssistantMessage = {
							role: "assistant",
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: createEmptyUsage(),
							timestamp: Date.now(),
							stopReason: requests++ === 0 ? "toolUse" : "stop",
							content:
								requests === 1
									? [{ type: "toolCall", id: "batch", name: "backlogPlan", arguments: args }]
									: [{ type: "text", text: "stop" }],
						};
						output.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
					});
					return output;
				},
			);
			const events: AgentEvent[] = [];
			try {
				for await (const event of stream) events.push(event);
			} finally {
				unsubscribe();
			}
			const messages = await stream.result();
			const result = messages.find((message) => message.role === "toolResult");
			expect(store.list().items.map((item) => item.title)).toEqual(["First"]);
			expect(changed).toHaveBeenCalledOnce();
			const serialized = JSON.stringify(result);
			expect(serialized).not.toContain("Added B1");
			expect(serialized).not.toContain("Cancelled add batch");
			if (behavior === "throw") {
				expect(result).toMatchObject({ isError: true });
				expect(result?.details).toEqual({});
				expect(serialized).toContain("Tool result post-processing failed: POST_HOOK_FAILURE");
				expect(serialized).toContain("Effects may already be applied");
				expect(serialized).toMatch(/inspect state before retrying/i);
				expect(serialized).not.toContain('"outcomes"');
			} else {
				expect(result).toMatchObject({
					isError: true,
					content: [{ type: "text", text: "REDACTED_RESULT" }],
					details: { redacted: true },
				});
				expect(serialized).not.toContain("post-processing failed");
			}
			expect(events.find((event) => event.type === "tool_execution_end")).toMatchObject({ isError: true });
			closeSharedAgentDb();
			root = tmp("octocode-post-hook-control-");
		}
	},
);
