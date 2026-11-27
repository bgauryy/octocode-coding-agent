import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

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

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

const convertToLlm = (messages: AgentMessage[]): Message[] =>
	messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");

const schema = Type.Object({ value: Type.String() });

/** Run one batch of three calls where the first call aborts the run; return events and the transcript. */
async function runAbortedBatch(mode: "sequential" | "parallel", abortIn: "execute" | "prepare") {
	const controller = new AbortController();
	const executed: string[] = [];
	const tool: AgentTool<typeof schema, undefined> = {
		name: "echo",
		label: "Echo",
		description: "Echo",
		parameters: schema,
		async execute(_id, params) {
			executed.push(params.value);
			if (abortIn === "execute" && params.value === "a") controller.abort();
			return { content: [{ type: "text", text: `echoed ${params.value}` }], details: undefined };
		},
	};
	const context: AgentContext = { messages: [], tools: [tool] };
	const config: AgentLoopConfig = {
		model,
		convertToLlm,
		toolExecution: mode,
		beforeToolCall: async ({ toolCall }) => {
			if (abortIn === "prepare" && toolCall.id === "call-a") controller.abort();
			return undefined;
		},
	};
	let call = 0;
	const stream = agentLoop(
		[{ role: "user", content: "go", timestamp: Date.now() }],
		context,
		config,
		controller.signal,
		() => {
			const mock = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message =
					call++ === 0
						? assistant(
								["a", "b", "c"].map((value) => ({
									type: "toolCall" as const,
									id: `call-${value}`,
									name: "echo",
									arguments: { value },
								})),
								"toolUse",
							)
						: assistant([{ type: "text", text: "stopped" }], "stop");
				mock.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
			});
			return mock;
		},
	);
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, executed, messages: await stream.result() };
}

describe.each([
	["sequential", "execute"],
	["parallel", "execute"],
	["sequential", "prepare"],
	["parallel", "prepare"],
] as const)("aborting a %s tool batch while a call is in %s", (mode, abortIn) => {
	it("records start, end and a result for every call the loop did not execute", async () => {
		const { events, executed, messages } = await runAbortedBatch(mode, abortIn);
		if (abortIn === "execute") expect(executed).toEqual(["a"]);
		else expect(executed).not.toContain("c");

		const ids = ["call-a", "call-b", "call-c"];
		for (const type of ["tool_execution_start", "tool_execution_end"] as const) {
			const seen = events.flatMap((event) => (event.type === type ? [event.toolCallId] : []));
			expect([...seen].sort()).toEqual(ids);
		}

		const results = messages.flatMap((message) => (message.role === "toolResult" ? [message] : []));
		expect(results.map((result) => result.toolCallId)).toEqual(ids);
		for (const skipped of results.slice(abortIn === "execute" ? 1 : 0)) {
			expect(skipped.isError).toBe(true);
			expect(skipped.content).toEqual([{ type: "text", text: "Operation aborted" }]);
		}

		const toolCallIds = messages.flatMap((message) =>
			message.role === "assistant"
				? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
				: [],
		);
		expect(results.map((result) => result.toolCallId).sort()).toEqual(toolCallIds.sort());
	});
});
