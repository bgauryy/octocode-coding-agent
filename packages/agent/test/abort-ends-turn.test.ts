import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { settleAbandonedTools } from "../src/agent/run-end.ts";
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

const schema = Type.Object({});

function replyWith(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }));
	return stream;
}

describe("a run aborted during its tools", () => {
	it("commits queued steering and ends with an aborted reply, preparing and sending no request", async () => {
		const controller = new AbortController();
		const tool: AgentTool<typeof schema, undefined> = {
			name: "stop",
			label: "Stop",
			description: "Aborts the run",
			parameters: schema,
			async execute() {
				controller.abort();
				return { content: [{ type: "text", text: "stopped" }], details: undefined };
			},
		};
		const calls = { stream: 0, apiKey: 0, prepareRequest: 0, prepareNextTurn: 0, transform: 0 };
		let steering: AgentMessage[] = [{ role: "user", content: "steer", timestamp: Date.now() }];
		const config: AgentLoopConfig = {
			model,
			convertToLlm,
			getApiKey: () => {
				calls.apiKey++;
				return "key";
			},
			transformContext: async (messages) => {
				calls.transform++;
				return messages;
			},
			prepareRequest: async () => {
				calls.prepareRequest++;
				return undefined;
			},
			prepareNextTurn: async () => {
				calls.prepareNextTurn++;
				return undefined;
			},
			getSteeringMessages: async () => {
				if (!controller.signal.aborted) return [];
				const taken = steering;
				steering = [];
				return taken;
			},
		};
		const context: AgentContext = { messages: [], tools: [tool] };
		const stream = agentLoop(
			[{ role: "user", content: "go", timestamp: Date.now() }],
			context,
			config,
			controller.signal,
			() => {
				calls.stream++;
				return replyWith(assistant([{ type: "toolCall", id: "call-1", name: "stop", arguments: {} }], "toolUse"));
			},
		);
		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		const messages = await stream.result();

		expect(calls).toEqual({ stream: 1, apiKey: 1, prepareRequest: 1, prepareNextTurn: 0, transform: 1 });
		expect(messages.map((message) => message.role).filter((role) => role !== "system")).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
			"assistant",
		]);
		const last = messages.at(-1) as AssistantMessage;
		expect(last).toMatchObject({ stopReason: "aborted", content: [], provider: "openai", model: "mock" });
		expect(last.errorMessage).toBeTruthy();
		const types = events.map((event) => event.type);
		expect(types.slice(-4)).toEqual(["message_start", "message_end", "turn_end", "agent_end"]);
		expect(types.filter((type) => type === "turn_start")).toHaveLength(2);
	});
});

describe("a failed tool batch", () => {
	it("aborts and waits for calls still running even when reporting the failure fails", async () => {
		let slowSignal: AbortSignal | undefined;
		let slowEnded = false;
		const tools: AgentTool<typeof schema, object>[] = [
			{
				name: "fast",
				label: "Fast",
				description: "fast",
				parameters: schema,
				execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
			},
			{
				name: "slow",
				label: "Slow",
				description: "slow",
				parameters: schema,
				async execute(_id, _params, signal) {
					slowSignal = signal;
					await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
					// The abort is not instant for a real tool: its end comes a moment later.
					await new Promise((resolve) => setTimeout(resolve, 20));
					slowEnded = true;
					return { content: [{ type: "text", text: "stopped" }], details: {} };
				},
			},
		];
		const agent = new Agent({
			initialState: { tools },
			streamFn: () =>
				replyWith(
					assistant(
						[
							{ type: "toolCall", id: "call-1", name: "fast", arguments: {} },
							{ type: "toolCall", id: "call-2", name: "slow", arguments: {} },
						],
						"toolUse",
					),
				),
		});
		const after: string[] = [];
		agent.subscribe(async (event) => {
			if (slowEnded) after.push(event.type);
			if (event.type === "tool_execution_end" && event.toolCallId === "call-1") {
				while (!slowSignal) await new Promise((resolve) => setTimeout(resolve, 1));
				throw new Error("persistence failed");
			}
			// The failure report itself fails too.
			if (event.type === "message_start" && event.message.role === "assistant" && event.message.stopReason === "error")
				throw new Error("report failed");
		});
		await expect(agent.prompt("run tools")).rejects.toThrow("report failed");
		expect(slowSignal?.aborted).toBe(true);
		expect(slowEnded).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
		// The abandoned call's end is refused: no listener hears from a run after it failed.
		expect(after).toEqual([]);
	});

	it("waits for abandoned calls only up to the grace period", async () => {
		const started = Date.now();
		await settleAbandonedTools([new Promise<void>(() => undefined)], 30);
		expect(Date.now() - started).toBeLessThan(1_000);
		await settleAbandonedTools([Promise.resolve()], 60_000);
	});
});
