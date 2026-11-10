import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type ToolCall,
} from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, EarlyToolStart } from "../src/types.ts";

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

const convertToLlm = (messages: AgentMessage[]): Message[] =>
	messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");

const schema = Type.Object({ value: Type.String() });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const call = (value: string, name = "read"): ToolCall => ({
	type: "toolCall",
	id: `call-${value}`,
	name,
	arguments: { value },
});

/** Logs `start:` and `end:` per value and `stream:` lines from the mock stream into one timeline. */
function tool(
	name: string,
	log: string[],
	concurrency?: AgentTool["concurrency"],
): AgentTool<typeof schema, undefined> {
	return {
		name,
		label: name,
		description: name,
		parameters: schema,
		...(concurrency ? { concurrency } : {}),
		async execute(_id, params, signal, onUpdate) {
			log.push(`start:${params.value}`);
			onUpdate?.({ content: [{ type: "text", text: `progress ${params.value}` }], details: undefined });
			if (signal?.aborted) {
				log.push(`aborted:${params.value}`);
				throw new Error("aborted");
			}
			log.push(`end:${params.value}`);
			return { content: [{ type: "text", text: params.value }], details: undefined };
		},
	};
}

/**
 * One turn streaming `blocks` (tool calls and a text block) with a pause between blocks, ending with `stopReason`; then a
 * final text turn. Returns the timeline, all events and the tool results.
 */
async function run(
	blocks: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	tools: AgentTool<any>[],
	log: string[],
	earlyStart: EarlyToolStart | undefined,
	config: Partial<AgentLoopConfig> = {},
) {
	let turn = 0;
	const stream = agentLoop(
		[{ role: "user", content: "go", timestamp: Date.now() }],
		{ messages: [], tools },
		{ model, convertToLlm, ...(earlyStart ? { earlyStart } : {}), ...config },
		undefined,
		() => {
			const mock = createAssistantMessageEventStream();
			if (turn++ > 0) {
				queueMicrotask(() =>
					mock.push({ type: "done", reason: "stop", message: message([{ type: "text", text: "ok" }], "stop") }),
				);
				return mock;
			}
			void (async () => {
				const partial = message([], stopReason);
				mock.push({ type: "start", partial });
				for (const [index, block] of blocks.entries()) {
					await sleep(15);
					partial.content.push(block);
					if (block.type === "toolCall") {
						mock.push({ type: "toolcall_start", contentIndex: index, partial });
						mock.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial });
					} else if (block.type === "text") {
						mock.push({ type: "text_start", contentIndex: index, partial });
						mock.push({ type: "text_end", contentIndex: index, content: block.text, partial });
					}
				}
				await sleep(15);
				log.push("stream:end");
				const final = message(blocks, stopReason);
				if (stopReason === "error" || stopReason === "aborted")
					mock.push({ type: "error", reason: stopReason, error: final });
				else mock.push({ type: "done", reason: stopReason as "toolUse" | "stop" | "length", message: final });
			})();
			return mock;
		},
	);
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	const results = events.flatMap((event) =>
		event.type === "message_end" && event.message.role === "toolResult" ? [event.message] : [],
	);
	return { events, results };
}

const always: EarlyToolStart = { mayStart: () => true };

describe("early tool starts while the assistant message streams", () => {
	it("starts a settled shared call before the message ends, and keeps today's event order", async () => {
		const log: string[] = [];
		const { events, results } = await run(
			[call("a"), call("b"), { type: "text", text: "t" }],
			"toolUse",
			[tool("read", log)],
			log,
			always,
		);
		expect(log.indexOf("start:a")).toBeLessThan(log.indexOf("stream:end"));
		expect(log.indexOf("start:b")).toBeLessThan(log.indexOf("stream:end"));
		// Subscribers see the message end before any tool event, a start before each update and end, results in call order.
		const kinds = events
			.filter(
				(event) =>
					event.type.startsWith("tool_execution") ||
					(event.type === "message_end" && event.message.role === "assistant"),
			)
			.map((event) => ("toolCallId" in event ? `${event.type}:${event.toolCallId}` : event.type));
		expect(kinds[0]).toBe("message_end");
		for (const id of ["call-a", "call-b"]) {
			const start = kinds.indexOf(`tool_execution_start:${id}`);
			const update = kinds.indexOf(`tool_execution_update:${id}`);
			expect(start).toBeGreaterThan(0);
			expect(update).toBeGreaterThan(start);
			expect(kinds.indexOf(`tool_execution_end:${id}`)).toBeGreaterThan(update);
		}
		expect(kinds.indexOf("tool_execution_start:call-a")).toBeLessThan(kinds.indexOf("tool_execution_start:call-b"));
		expect(results.map((result) => [result.toolCallId, result.isError])).toEqual([
			["call-a", false],
			["call-b", false],
		]);
	});

	it("never starts the last call before the message ends, and starts nothing when the setting is off", async () => {
		const log: string[] = [];
		await run([call("a")], "toolUse", [tool("read", log)], log, always);
		expect(log.indexOf("start:a")).toBeGreaterThan(log.indexOf("stream:end"));
		const off: string[] = [];
		await run([call("a"), call("b")], "toolUse", [tool("read", off)], off, undefined);
		expect(off.indexOf("start:a")).toBeGreaterThan(off.indexOf("stream:end"));
	});

	it("runs no call of a truncated message to completion, and fails every call with the output-limit error", async () => {
		const log: string[] = [];
		const discarded: string[] = [];
		const { results } = await run(
			[call("a"), call("b"), call("cut")],
			"length",
			[tool("read", log, () => "shared")],
			log,
			{ mayStart: () => true, onDiscarded: (id) => discarded.push(id) },
			{
				beforeToolCall: async () => {
					await sleep(40);
					return undefined;
				},
			},
		);
		expect(log.filter((line) => line.startsWith("end:"))).toEqual([]);
		expect(log).not.toContain("start:cut");
		expect(discarded).toEqual(["call-a", "call-b"]);
		expect(results.map((result) => result.toolCallId)).toEqual(["call-a", "call-b", "call-cut"]);
		for (const result of results) {
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result.content)).toContain("output limit");
		}
	});

	it("discards early calls of a message that ends in an error, emitting no tool events", async () => {
		const log: string[] = [];
		const discarded: string[] = [];
		const { events } = await run(
			[call("a"), call("b")],
			"error",
			[tool("read", log)],
			log,
			{ mayStart: () => true, onDiscarded: (id) => discarded.push(id) },
			{
				beforeToolCall: async () => {
					await sleep(40);
					return undefined;
				},
			},
		);
		expect(discarded).toEqual(["call-a"]);
		expect(log.filter((line) => line.startsWith("end:"))).toEqual([]);
		expect(events.some((event) => event.type.startsWith("tool_execution"))).toBe(false);
	});

	it("starts early only the prefix before the first refused or exclusive call", async () => {
		const log: string[] = [];
		await run(
			[call("a"), call("e", "edit"), call("b"), { type: "text", text: "t" }],
			"toolUse",
			[tool("read", log), tool("edit", log, "exclusive")],
			log,
			always,
		);
		expect(log.indexOf("start:a")).toBeLessThan(log.indexOf("stream:end"));
		expect(log.indexOf("start:e")).toBeGreaterThan(log.indexOf("stream:end"));
		expect(log.indexOf("start:b")).toBeGreaterThan(log.indexOf("end:e"));

		const refused: string[] = [];
		await run(
			[call("x"), call("y"), call("z"), { type: "text", text: "t" }],
			"toolUse",
			[tool("read", refused)],
			refused,
			{ mayStart: (toolCall) => toolCall.id !== "call-y" },
		);
		expect(refused.indexOf("start:x")).toBeLessThan(refused.indexOf("stream:end"));
		expect(refused.indexOf("start:y")).toBeGreaterThan(refused.indexOf("stream:end"));
		expect(refused.indexOf("start:z")).toBeGreaterThan(refused.indexOf("stream:end"));
	});

	it("withdraws a call whose early check defers: no early attempt shows, it runs once through the normal path", async () => {
		const log: string[] = [];
		const checks: string[] = [];
		const { events, results } = await run(
			[call("a"), call("b"), { type: "text", text: "t" }],
			"toolUse",
			[tool("read", log)],
			log,
			always,
			{
				beforeToolCall: async ({ toolCall, early }) => {
					checks.push(`${toolCall.id}:${early ? "early" : "normal"}`);
					if (early) return { defer: true };
					log.push(`check:${toolCall.id}`);
					return undefined;
				},
			},
		);
		// The first call was tried early and deferred; no call started or checked normally before the message ended.
		expect(checks).toContain("call-a:early");
		expect(checks.filter((check) => check.endsWith(":normal")).sort()).toEqual(["call-a:normal", "call-b:normal"]);
		expect(log.indexOf("start:a")).toBeGreaterThan(log.indexOf("stream:end"));
		expect(log.indexOf("check:call-a")).toBeGreaterThan(log.indexOf("stream:end"));
		expect(log.filter((line) => line === "start:a")).toHaveLength(1);
		expect(log.filter((line) => line === "start:b")).toHaveLength(1);
		const toolEvents = events
			.filter((event) => event.type === "tool_execution_start" || event.type === "tool_execution_end")
			.map((event) => `${event.type}:${(event as { toolCallId: string }).toolCallId}`);
		expect(toolEvents.filter((line) => line.startsWith("tool_execution_start"))).toEqual([
			"tool_execution_start:call-a",
			"tool_execution_start:call-b",
		]);
		expect(results.map((result) => [result.toolCallId, result.isError])).toEqual([
			["call-a", false],
			["call-b", false],
		]);
	});
});

/** Net count of `abort` listeners on a signal: what the loop added and did not remove. */
function trackAbortListeners(signal: AbortSignal) {
	const active = new Set<unknown>();
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	signal.addEventListener = ((type: string, listener: any, options?: any) => {
		if (type === "abort") active.add(listener);
		add(type, listener, options);
	}) as typeof signal.addEventListener;
	signal.removeEventListener = ((type: string, listener: any, options?: any) => {
		if (type === "abort") active.delete(listener);
		remove(type, listener, options);
	}) as typeof signal.removeEventListener;
	return active;
}

describe("early start cleanup", () => {
	it("leaves no abort listener on the run's signal after a turn without tool calls", async () => {
		const controller = new AbortController();
		const active = trackAbortListeners(controller.signal);
		const stream = agentLoop(
			[{ role: "user", content: "go", timestamp: Date.now() }],
			{ messages: [], tools: [tool("read", [])] },
			{ model, convertToLlm, earlyStart: always },
			controller.signal,
			() => {
				const mock = createAssistantMessageEventStream();
				queueMicrotask(() =>
					mock.push({ type: "done", reason: "stop", message: message([{ type: "text", text: "ok" }], "stop") }),
				);
				return mock;
			},
		);
		for await (const _event of stream);
		expect(active.size).toBe(0);
	});

	it("discards the early runs and unlinks the signal when the stream throws", async () => {
		const controller = new AbortController();
		const active = trackAbortListeners(controller.signal);
		const discarded: string[] = [];
		const log: string[] = [];
		const a = call("a");
		const partial = message([a, { type: "text", text: "t" }], "toolUse");
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial },
			{ type: "toolcall_start", contentIndex: 0, partial },
			{ type: "toolcall_end", contentIndex: 0, toolCall: a, partial },
			{ type: "text_start", contentIndex: 1, partial },
		];
		const stream = agentLoop(
			[{ role: "user", content: "go", timestamp: Date.now() }],
			{ messages: [], tools: [tool("read", log)] },
			{
				model,
				convertToLlm,
				earlyStart: { mayStart: () => true, onDiscarded: (id) => discarded.push(id) },
				beforeToolCall: async () => {
					await sleep(30);
					return undefined;
				},
			},
			controller.signal,
			() =>
				({
					async *[Symbol.asyncIterator]() {
						yield* events;
						await sleep(5);
						throw new Error("boom");
					},
					result: async () => partial,
				}) as unknown as ReturnType<typeof createAssistantMessageEventStream>,
		);
		const seen: AgentEvent[] = [];
		for await (const event of stream) seen.push(event);
		expect(JSON.stringify(seen)).toContain("boom");
		expect(discarded).toEqual(["call-a"]);
		expect(active.size).toBe(0);
		expect(log.filter((line) => line.startsWith("end:"))).toEqual([]);
	});
});
