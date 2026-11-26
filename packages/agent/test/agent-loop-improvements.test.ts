import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type ToolCall,
} from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type InputBatch } from "../src/index.ts";
import { agentLoop } from "../src/agent-loop.ts";

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

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
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

function makeTool(
	name: string,
	execute: AgentTool["execute"] = async () => ({ content: [{ type: "text", text: `ran:${name}` }], details: {} }),
	concurrency?: AgentTool["concurrency"],
): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({ value: Type.Optional(Type.String()) }),
		...(concurrency ? { concurrency } : {}),
		execute,
	};
}

const convertToLlm = (messages: AgentMessage[]): Message[] =>
	messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");

describe("Agent & loop reliability and de-rigidification (TDD)", () => {
	it("wires resolveUndeclaredTool from AgentOptions and refreshes context.tools across turns", async () => {
		const hiddenTool = makeTool("on_demand");
		let turn = 0;
		const agent = new Agent({
			initialState: { model, systemPrompt: "Test", tools: [] },
			resolveUndeclaredTool: (name) => {
				if (name !== "on_demand") return undefined;
				agent.state.tools = [...agent.state.tools, hiddenTool];
				return hiddenTool;
			},
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				const currentTurn = turn++;
				queueMicrotask(() => {
					if (currentTurn === 0 || currentTurn === 1) {
						stream.push({
							type: "done",
							reason: "toolUse",
							message: assistantMessage(
								[{ type: "toolCall", id: `c-${currentTurn}`, name: "on_demand", arguments: {} }],
								"toolUse",
							),
						});
					} else {
						stream.push({
							type: "done",
							reason: "stop",
							message: assistantMessage([{ type: "text", text: "all done" }], "stop"),
						});
					}
				});
				return stream;
			},
		});

		const resolveSpy = vi.spyOn(agent, "resolveUndeclaredTool");
		await agent.prompt("use hidden tool twice");

		const toolResults = agent.state.messages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		expect(toolResults.every((r) => !r.isError)).toBe(true);
		// Turn 0 resolved it via resolveUndeclaredTool; Turn 1 found it in refreshed context.tools without re-resolving!
		expect(resolveSpy).toHaveBeenCalledTimes(1);
	});

	it("preserves tools explicitly replaced by prepareNextTurnWithContext", async () => {
		const stateTool = makeTool("state_tool");
		const hookTool = makeTool("hook_tool");
		const requests: string[][] = [];
		let turn = 0;
		const agent = new Agent({
			initialState: { model, tools: [stateTool] },
			prepareNextTurnWithContext: (next) => ({
				context: { ...next.context, tools: [hookTool] },
			}),
			streamFn: (_model, context) => {
				requests.push(
					context.messages.flatMap((message) =>
						message.role === "system"
							? [
									`+${(message.toolsAdded ?? []).map((tool) => tool.name).join(",")}`,
									`-${(message.toolsRemoved ?? []).map((tool) => tool.name).join(",")}`,
								]
							: [],
					),
				);
				const currentTurn = turn++;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const message =
						currentTurn === 0
							? assistantMessage([{ type: "toolCall", id: "call-state", name: "state_tool", arguments: {} }], "toolUse")
							: assistantMessage([{ type: "text", text: "done" }], "stop");
					stream.push({ type: "done", reason: currentTurn === 0 ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("replace the next turn's tools");

		expect(requests).toEqual([
			["+state_tool", "-"],
			["+state_tool", "-", "+hook_tool", "-state_tool"],
		]);
	});

	it("enforces BeforeToolCallResult.halt immediately across mixed batches without draining queued turns", async () => {
		const preparedThird = vi.fn();
		const executedThird = vi.fn();
		let streamCalls = 0;
		const okTool = makeTool("ok_tool");
		const guardTool = makeTool("guarded_tool");
		const thirdTool = makeTool("third_tool", async () => {
			executedThird();
			return { content: [{ type: "text", text: "third" }], details: {} };
		});

		const agent = new Agent({
			initialState: { model, tools: [okTool, guardTool, thirdTool] },
			beforeToolCall: async ({ toolCall }) => {
				if (toolCall.id === "call-3") preparedThird();
				if (toolCall.id === "call-2") {
					return { block: true, halt: true, terminate: true, reason: "Budget hard limit reached" };
				}
				return undefined;
			},
			streamFn: () => {
				const callIndex = streamCalls++;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (callIndex > 2) {
						stream.push({
							type: "done",
							reason: "stop",
							message: assistantMessage([{ type: "text", text: "ran past halt" }], "stop"),
						});
						return;
					}
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{ type: "toolCall", id: "call-1", name: "ok_tool", arguments: {} },
								{ type: "toolCall", id: "call-2", name: "guarded_tool", arguments: {} },
								{ type: "toolCall", id: "call-3", name: "third_tool", arguments: {} },
							],
							"toolUse",
						),
					});
				});
				return stream;
			},
		});

		agent.steer({ role: "user", content: "queued steer", timestamp: Date.now() });
		agent.followUp({ role: "user", content: "queued follow-up", timestamp: Date.now() });

		await agent.prompt("go");

		expect(streamCalls).toBe(1);
		expect(preparedThird).not.toHaveBeenCalled();
		expect(executedThird).not.toHaveBeenCalled();
		// Every toolCall in the assistant message still gets a toolResult so no orphan toolCall remains in transcript.
		const results = agent.state.messages.filter((m) => m.role === "toolResult");
		expect(results.map((r) => r.toolCallId)).toEqual(["call-1", "call-2", "call-3"]);
		expect(results[2]?.isError).toBe(true);
		// Queued steer and follow-up remain undrained rather than fueling another model request after a hard halt.
		expect(agent.hasQueuedMessages()).toBe(true);
	});

	it("preserves steer/followUp batch kind and prevents double-drain on Agent.continue() with refreshInput", async () => {
		const selected: InputBatch[] = [];
		let requests = 0;
		const agent = new Agent({
			initialState: {
				model,
				messages: [
					{ role: "user", content: "first", timestamp: 1 },
					assistantMessage([{ type: "text", text: "first reply" }], "stop"),
				],
			},
			steeringMode: "one-at-a-time",
			onInputSelected: (batch) => selected.push(batch),
			prepareRequest: () => ({ refreshInput: true }),
			streamFn: () => {
				requests++;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: `reply-${requests}` }], "stop"),
					});
				});
				return stream;
			},
		});

		agent.steer({ role: "user", content: "steer-1", timestamp: 2 });
		agent.steer({ role: "user", content: "steer-2", timestamp: 3 });

		await agent.continue();

		// In one-at-a-time mode, Turn 1 gets steer-1 (with kind "steer", NOT "initial") and Turn 2 gets steer-2.
		expect(requests).toBe(2);
		expect(selected.map((b) => [b.kind, b.messages.length])).toEqual([
			["steer", 1],
			["steer", 1],
		]);
	});

	it("does not drain followUpMessages when aborted during a terminate:true tool call", async () => {
		const controller = new AbortController();
		const followUpPolled = vi.fn(async () => [{ role: "user" as const, content: "should stay queued", timestamp: 2 }]);
		const termTool = makeTool("term", async () => {
			controller.abort();
			return { content: [{ type: "text", text: "done" }], details: {}, terminate: true };
		});

		const stream = agentLoop(
			[{ role: "user", content: "start", timestamp: 1 }],
			{ messages: [], tools: [termTool] },
			{
				model,
				convertToLlm,
				getFollowUpMessages: followUpPolled,
			},
			controller.signal,
			() => {
				const s = createAssistantMessageEventStream();
				queueMicrotask(() => {
					s.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage([{ type: "toolCall", id: "t1", name: "term", arguments: {} }], "toolUse"),
					});
				});
				return s;
			},
		);

		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		expect(followUpPolled).not.toHaveBeenCalled();
	});

	it("starts undeclared shared tools early via resolveUndeclaredTool and skips onDiscarded for deferred calls", async () => {
		const log: string[] = [];
		const discarded: string[] = [];
		const undeclaredRead = makeTool(
			"undeclared_read",
			async (_id, params) => {
				const val = (params as { value?: string }).value ?? "";
				log.push(`start:${val}`);
				return { content: [{ type: "text", text: val }], details: {} };
			},
			"shared",
		);
		const callA: ToolCall = { type: "toolCall", id: "call-a", name: "undeclared_read", arguments: { value: "a" } };
		const callB: ToolCall = { type: "toolCall", id: "call-b", name: "undeclared_read", arguments: { value: "b" } };

		let turn = 0;
		const stream = agentLoop(
			[{ role: "user", content: "go", timestamp: 1 }],
			{ messages: [], tools: [] },
			{
				model,
				convertToLlm,
				resolveUndeclaredTool: (name) => (name === "undeclared_read" ? undeclaredRead : undefined),
				earlyStart: {
					mayStart: () => true,
					onDiscarded: (id) => discarded.push(id),
				},
			},
			undefined,
			() => {
				const s = createAssistantMessageEventStream();
				if (turn++ > 0) {
					queueMicrotask(() => s.push({ type: "done", reason: "stop", message: assistantMessage([], "stop") }));
					return s;
				}
				void (async () => {
					const partial = assistantMessage([], "toolUse");
					s.push({ type: "start", partial });
					partial.content.push(callA);
					s.push({ type: "toolcall_start", contentIndex: 0, partial });
					s.push({ type: "toolcall_end", contentIndex: 0, toolCall: callA, partial });
					partial.content.push(callB);
					s.push({ type: "toolcall_start", contentIndex: 1, partial });
					s.push({ type: "toolcall_end", contentIndex: 1, toolCall: callB, partial });
					await new Promise((r) => setTimeout(r, 15));
					log.push("stream:end");
					s.push({ type: "done", reason: "toolUse", message: assistantMessage([callA, callB], "toolUse") });
				})();
				return s;
			},
		);

		for await (const _event of stream);
		expect(log.indexOf("start:a")).toBeLessThan(log.indexOf("stream:end"));
		expect(discarded).toEqual([]);

		// Now verify that a call whose early check settled `{ defer: true }` is NOT reported to onDiscarded on error.
		const deferredDiscarded: string[] = [];
		const errStream = agentLoop(
			[{ role: "user", content: "go", timestamp: 1 }],
			{ messages: [], tools: [undeclaredRead] },
			{
				model,
				convertToLlm,
				earlyStart: {
					mayStart: () => true,
					onDiscarded: (id) => deferredDiscarded.push(id),
				},
				beforeToolCall: async ({ early }) => (early ? { defer: true } : undefined),
			},
			undefined,
			() => {
				const s = createAssistantMessageEventStream();
				void (async () => {
					const partial = assistantMessage([], "error");
					s.push({ type: "start", partial });
					partial.content.push(callA);
					s.push({ type: "toolcall_start", contentIndex: 0, partial });
					s.push({ type: "toolcall_end", contentIndex: 0, toolCall: callA, partial });
					partial.content.push({ type: "text", text: "later" });
					s.push({ type: "text_start", contentIndex: 1, partial });
					await new Promise((r) => setTimeout(r, 15));
					s.push({ type: "error", reason: "error", error: assistantMessage([callA], "error") });
				})();
				return s;
			},
		);
		for await (const _event of errStream);
		expect(deferredDiscarded).toEqual([]);
	});
});
