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
import { STATUS } from "../../src/octocode/shared/status.ts";
import { batchAdd } from "../../src/octocode/backlog/tool-batch.ts";
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
	const { agent } = workspaceDb(cwd, env);
	const tool = fake.tools.get("backlogPlan");
	return { ctx, tool, store, agent, changed };
}

it.each(["sequential", "parallel"] as const)(
	"keeps committed and refused entries in the actual %s loop after cancellation",
	async (mode) => {
		const changed = vi.fn(() => {
			if (mode === "parallel") throw new Error("observer failed");
		});
		const { ctx, tool, store, agent } = fixture(changed);
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
		expect(JSON.stringify(result)).toContain("Cancelled add batch");
		expect(result).toMatchObject({
			isError: true,
			details: {
				status: "aborted",
				operation: "add",
				requested: 3,
				applied: 1,
				refused: 1,
				uncertain: 0,
				notAttempted: 1,
				outcomes: [
					{ index: 0, status: "refused" },
					{ index: 1, status: "applied" },
				],
			},
		});
		expect(JSON.stringify(result)).toContain("Added B1");
		expect(JSON.stringify(result)).toContain("Inspect the listed items before retrying");
		expect(events.find((event) => event.type === "tool_execution_end")).toMatchObject({
			isError: true,
			result: { details: { applied: 1, refused: 1, notAttempted: 1 } },
		});
		expect(store.list().items.map((item) => item.title)).toEqual(["First"]);
		expect(changed).toHaveBeenCalledOnce();
	},
);

it("does not start a native batch or notify changes when aborted before its first entry", async () => {
	const { ctx, tool, store, changed } = fixture();
	const controller = new AbortController();
	controller.abort();
	await expect(
		tool.execute(
			"batch",
			{ op: "add", items: [{ title: "First" }, { title: "Second" }] },
			controller.signal,
			undefined,
			ctx,
		),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(store.list().total).toBe(0);
	expect(changed).not.toHaveBeenCalled();
});

it("refreshes the actual composed backlog footer after an earlier entry committed in a cancelled batch", async () => {
	const { ctx, tool, store, agent } = fixture(vi.fn(), true);
	const controller = new AbortController();
	const unsubscribe = agent.onCommit(() => {
		if (store.list().total) controller.abort();
	});
	try {
		await expect(
			tool.execute(
				"batch",
				{
					op: "add",
					items: [
						{ title: "First", why: "fixture", goal: "fixture" },
						{ title: "Second", why: "fixture", goal: "fixture" },
					],
				},
				controller.signal,
				undefined,
				ctx,
			),
		).rejects.toMatchObject({ name: "AbortError", result: { details: { applied: 1, notAttempted: 1 } } });
	} finally {
		unsubscribe();
	}
	expect(ctx.ui.statuses.has(STATUS.backlog)).toBe(true);
	expect(ctx.ui.statuses.get(STATUS.backlog)).toContain("1");
});

it("separates an unacknowledged started entry from known commits and writes never attempted", async () => {
	const controller = new AbortController();
	const effects: string[] = [];
	const result = await batchAdd(
		[{ title: "First" }, { title: "Uncertain" }, { title: "Not started" }],
		["title"],
		"items",
		(entry) => {
			effects.push(String(entry.title));
			if (effects.length === 2) {
				controller.abort();
				throw new Error("acknowledgement lost");
			}
			return { content: [{ type: "text", text: `Applied ${entry.title}` }] };
		},
		undefined,
		controller.signal,
	).catch((error) => error);
	expect(result).toMatchObject({
		name: "AbortError",
		result: {
			isError: true,
			details: {
				applied: 1,
				refused: 0,
				uncertain: 1,
				notAttempted: 1,
				outcomes: [
					{ index: 0, status: "applied" },
					{ index: 1, status: "unknown" },
				],
			},
		},
	});
	expect(effects).toEqual(["First", "Uncertain"]);
	expect(result.result.content[0].text).toContain("may already have applied");
});
