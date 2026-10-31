import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
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

const assistant = (
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

const convertToLlm = (messages: AgentMessage[]): Message[] =>
	messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");

const schema = Type.Object({ value: Type.String() });

function echoTool(executed: string[]): AgentTool<typeof schema, undefined> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo",
		parameters: schema,
		async execute(_id, params) {
			executed.push(params.value);
			return { content: [{ type: "text", text: `echoed ${params.value}` }], details: undefined };
		},
	};
}

/** Run one turn that issues `values` as echo calls, then ends; return the tool results in call order. */
async function runBatch(values: string[], config: Partial<AgentLoopConfig>, executed: string[]) {
	let turn = 0;
	const stream = agentLoop(
		[{ role: "user", content: "go", timestamp: Date.now() }],
		{ messages: [], tools: [echoTool(executed)] },
		{ model, convertToLlm, ...config },
		undefined,
		() => {
			const mock = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message =
					turn++ === 0
						? assistant(
								values.map((value) => ({
									type: "toolCall" as const,
									id: `call-${value}`,
									name: "echo",
									arguments: { value },
								})),
								"toolUse",
							)
						: assistant([{ type: "text", text: "done" }], "stop");
				mock.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
			});
			return mock;
		},
	);
	for await (const _event of stream) {
		/* drain */
	}
	return (await stream.result()).flatMap((message) => (message.role === "toolResult" ? [message] : []));
}

/**
 * One batch of two calls. "a" is approved first; while "b" is still being approved (a prompt, a hook) the world changes,
 * so "a" would now be refused.
 */
function staleApproval(withRevalidate: boolean): Partial<AgentLoopConfig> {
	let held = false;
	return {
		beforeToolCall: async ({ toolCall }) => {
			if (toolCall.id === "call-b") held = true;
			if (toolCall.id !== "call-a" || !withRevalidate) return undefined;
			return {
				revalidate: async () => (held ? { block: true, reason: "path is now reserved by a peer" } : undefined),
			};
		},
	};
}

describe("a call revalidated right before it executes", () => {
	it("runs on state that changed after its approval when the hook does not revalidate", async () => {
		const executed: string[] = [];
		await runBatch(["a", "b"], { toolExecution: "parallel", ...staleApproval(false) }, executed);
		expect(executed).toEqual(["a", "b"]);
	});

	it("is refused in a parallel batch when its approval went stale, and the other call still runs", async () => {
		const executed: string[] = [];
		const [a, b] = await runBatch(["a", "b"], { toolExecution: "parallel", ...staleApproval(true) }, executed);
		expect(executed).toEqual(["b"]);
		expect(a.isError).toBe(true);
		expect(a.content).toEqual([{ type: "text", text: "path is now reserved by a peer" }]);
		expect(b.isError).toBe(false);
	});

	it("runs a call whose approval is still current", async () => {
		// Sequential: "a" executes before "b" is approved, so nothing went stale.
		const executed: string[] = [];
		const results = await runBatch(["a", "b"], { toolExecution: "sequential", ...staleApproval(true) }, executed);
		expect(executed).toEqual(["a", "b"]);
		expect(results.every((result) => !result.isError)).toBe(true);
	});

	it("fails closed when revalidation throws", async () => {
		const executed: string[] = [];
		const [result] = await runBatch(
			["a"],
			{
				beforeToolCall: async () => ({
					revalidate: async () => {
						throw new Error("team database unavailable");
					},
				}),
			},
			executed,
		);
		expect(executed).toEqual([]);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "team database unavailable" }]);
	});
});
