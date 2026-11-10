import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, ToolConcurrency } from "../src/types.ts";

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

const schema = Type.Object({ value: Type.String(), ms: Type.Optional(Type.Number()) });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A tool logging `start:<value>` and `end:<value>`, running `ms` long. */
function loggingTool(
	name: string,
	log: string[],
	concurrency?: AgentTool["concurrency"],
	executionMode?: AgentTool["executionMode"],
): AgentTool<typeof schema, undefined> {
	return {
		name,
		label: name,
		description: name,
		parameters: schema,
		...(concurrency ? { concurrency } : {}),
		...(executionMode ? { executionMode } : {}),
		async execute(_id, params) {
			log.push(`start:${params.value}`);
			await sleep(params.ms ?? 0);
			log.push(`end:${params.value}`);
			return { content: [{ type: "text", text: params.value }], details: undefined };
		},
	};
}

type Call = { tool: string; value: string; ms?: number };

/** One turn issuing `calls`, then a final text turn; returns the events and the tool results in emitted order. */
async function runBatch(calls: Call[], tools: AgentTool<any>[], config: Partial<AgentLoopConfig> = {}) {
	let turn = 0;
	const stream = agentLoop(
		[{ role: "user", content: "go", timestamp: Date.now() }],
		{ messages: [], tools },
		{ model, convertToLlm, ...config },
		undefined,
		() => {
			const mock = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message =
					turn++ === 0
						? assistant(
								calls.map((call) => ({
									type: "toolCall" as const,
									id: `call-${call.value}`,
									name: call.tool,
									arguments: { value: call.value, ...(call.ms === undefined ? {} : { ms: call.ms }) },
								})),
								"toolUse",
							)
						: assistant([{ type: "text", text: "done" }], "stop");
				mock.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
			});
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

describe("per-call shared/exclusive scheduling", () => {
	it("orders a mixed batch: shared calls overlap, an exclusive call waits for every earlier call and holds every later one", async () => {
		const log: string[] = [];
		const tools = [loggingTool("read", log), loggingTool("edit", log, "exclusive")];
		const { results } = await runBatch(
			[
				{ tool: "read", value: "r1", ms: 30 },
				{ tool: "read", value: "r2", ms: 10 },
				{ tool: "edit", value: "e", ms: 10 },
				{ tool: "read", value: "r3" },
				{ tool: "read", value: "r4" },
			],
			tools,
		);
		// r1 and r2 overlap; e starts after both ended; r3 and r4 start after e ended.
		expect(log.indexOf("start:r2")).toBeLessThan(log.indexOf("end:r1"));
		expect(log.indexOf("start:e")).toBeGreaterThan(Math.max(log.indexOf("end:r1"), log.indexOf("end:r2")));
		expect(log.indexOf("start:r3")).toBeGreaterThan(log.indexOf("end:e"));
		expect(log.indexOf("start:r4")).toBeGreaterThan(log.indexOf("end:e"));
		// Results keep call order whatever the completion order.
		expect(results.map((result) => result.toolCallId)).toEqual(["call-r1", "call-r2", "call-e", "call-r3", "call-r4"]);
	});

	it("lets shared calls on both sides of an executionMode=sequential call overlap among themselves", async () => {
		const log: string[] = [];
		const tools = [loggingTool("read", log), loggingTool("ext", log, undefined, "sequential")];
		await runBatch(
			[
				{ tool: "ext", value: "x" },
				{ tool: "read", value: "r1", ms: 20 },
				{ tool: "read", value: "r2" },
			],
			tools,
		);
		expect(log.indexOf("start:r1")).toBeGreaterThan(log.indexOf("end:x"));
		expect(log.indexOf("start:r2")).toBeLessThan(log.indexOf("end:r1"));
	});

	it("decides per call from the validated arguments, and treats a resolver that throws as exclusive", async () => {
		const log: string[] = [];
		const byArgs = (args: Record<string, unknown>): ToolConcurrency => {
			if (args.value === "boom") throw new Error("no verdict");
			return "shared";
		};
		const tools = [loggingTool("t", log, byArgs)];
		await runBatch(
			[
				{ tool: "t", value: "a", ms: 20 },
				{ tool: "t", value: "boom" },
				{ tool: "t", value: "b" },
			],
			tools,
		);
		expect(log.indexOf("start:boom")).toBeGreaterThan(log.indexOf("end:a"));
		expect(log.indexOf("start:b")).toBeGreaterThan(log.indexOf("end:boom"));
	});

	it("starts an approved call while a later call's approval (a dialog) is still pending", async () => {
		const log: string[] = [];
		let startedBeforeSecondApproval = false;
		const tools = [loggingTool("read", log)];
		const { results } = await runBatch(
			[
				{ tool: "read", value: "a" },
				{ tool: "read", value: "b" },
			],
			tools,
			{
				beforeToolCall: async ({ toolCall }) => {
					if (toolCall.id !== "call-b") return undefined;
					await sleep(30);
					startedBeforeSecondApproval = log.includes("end:a");
					return undefined;
				},
			},
		);
		expect(startedBeforeSecondApproval).toBe(true);
		expect(results.map((result) => result.toolCallId)).toEqual(["call-a", "call-b"]);
	});
});
