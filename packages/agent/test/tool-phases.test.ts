import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type ToolResultMessage,
} from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

const message = (
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-responses",
	provider: "openai",
	model: "mock",
	usage,
	stopReason,
	timestamp: Date.now(),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const schema = Type.Object({ ms: Type.Number() });

function tool(name: string, concurrency: "shared" | "exclusive"): AgentTool<typeof schema> {
	return {
		name,
		label: name,
		description: name,
		parameters: schema,
		concurrency,
		async execute(_id, params) {
			await sleep(params.ms);
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

async function run(
	calls: Array<{ id: string; name: string; ms: number }>,
	config: Partial<AgentLoopConfig>,
): Promise<Map<string, ToolResultMessage>> {
	let turn = 0;
	const streamFn = () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const reply =
				turn++ === 0
					? message(
							calls.map((call) => ({
								type: "toolCall" as const,
								id: call.id,
								name: call.name,
								arguments: { ms: call.ms },
							})),
							"toolUse",
						)
					: message([{ type: "text", text: "done" }], "stop");
			stream.push({ type: "done", reason: reply.stopReason === "toolUse" ? "toolUse" : "stop", message: reply });
		});
		return stream;
	};
	const stream = agentLoop(
		[{ role: "user", content: "go", timestamp: Date.now() }],
		{ messages: [], tools: [tool("shared", "shared"), tool("exclusive", "exclusive")] },
		{
			model,
			convertToLlm: (messages: AgentMessage[]) => messages as Message[],
			...config,
		},
		undefined,
		streamFn,
	);
	for await (const _event of stream) {
		// drain
	}
	const results = (await stream.result()).filter((entry): entry is ToolResultMessage => entry.role === "toolResult");
	return new Map(results.map((result) => [result.toolCallId, result]));
}

describe("tool call phases", () => {
	it("records preparation, schedule wait, finalization and held time beside the execution", async () => {
		const results = await run(
			[
				{ id: "slow", name: "shared", ms: 80 },
				{ id: "fast", name: "shared", ms: 1 },
				{ id: "after", name: "exclusive", ms: 1 },
			],
			{
				beforeToolCall: async ({ toolCall }) => {
					if (toolCall.id === "slow") await sleep(40);
				},
				afterToolCall: async ({ toolCall }) => {
					if (toolCall.id === "slow") await sleep(30);
					return undefined;
				},
			},
		);
		const slow = results.get("slow")!;
		const fast = results.get("fast")!;
		const after = results.get("after")!;
		expect(slow.phases?.prepareMs).toBeGreaterThanOrEqual(35);
		expect(slow.phases?.finalizeMs).toBeGreaterThanOrEqual(25);
		expect(slow.durationMs).toBeGreaterThanOrEqual(75);
		// The fast call ended long before the batch could return: its result was held for the slow one.
		expect(fast.phases?.heldMs).toBeGreaterThanOrEqual(60);
		// The exclusive call waited for both shared calls to end (the slow one's execution and finalization).
		expect(after.phases?.queuedMs).toBeGreaterThanOrEqual(90);
		expect(slow.phases?.early).toBeUndefined();
	});

	it("leaves out phases under a millisecond", async () => {
		const results = await run([{ id: "only", name: "shared", ms: 1 }], {});
		const phases = results.get("only")!.phases ?? {};
		for (const value of Object.values(phases)) expect(value).toBeGreaterThanOrEqual(1);
		expect(phases).not.toHaveProperty("queuedMs");
	});

	it("times the preparation of a call that never ran", async () => {
		const results = await run([{ id: "blocked", name: "shared", ms: 1 }], {
			beforeToolCall: async () => {
				await sleep(20);
				return { block: true, reason: "no" };
			},
		});
		const blocked = results.get("blocked")!;
		expect(blocked.isError).toBe(true);
		expect(blocked).not.toHaveProperty("durationMs");
		expect(blocked.phases?.prepareMs).toBeGreaterThanOrEqual(15);
	});
});
