import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	parseToolCallArguments,
	type ToolCall,
	type UserMessage,
} from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

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

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	outputTokens = 0,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: outputTokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: outputTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/** A tool call the way a provider finalizes it from the model's streamed arguments text. */
function finalizedCall(id: string, name: string, argumentsText: string): ToolCall {
	return { type: "toolCall", id, name, ...parseToolCallArguments(argumentsText) };
}

const identityConverter = (messages: AgentMessage[]): Message[] =>
	messages.filter((m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult");

/** Runs one scripted assistant turn, then a closing text turn; returns what each tool result told the model. */
async function runScriptedTurn(first: AssistantMessage) {
	const executed: unknown[] = [];
	const tool: AgentTool<ReturnType<typeof Type.Object>> = {
		name: "file",
		label: "File",
		description: "Write files",
		parameters: Type.Object({ queries: Type.Array(Type.Object({ path: Type.String(), text: Type.String() })) }),
		async execute(_id, params) {
			executed.push(params);
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
	const context: AgentContext = { messages: [], tools: [tool] };
	const config: AgentLoopConfig = { model, convertToLlm: identityConverter };
	let turn = 0;
	const streamFn = () => {
		const stream = createAssistantMessageEventStream();
		const message = turn++ === 0 ? first : assistant([{ type: "text", text: "done" }], "stop");
		queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason as "stop", message }));
		return stream;
	};
	const prompt: UserMessage = { role: "user", content: "write the report", timestamp: Date.now() };
	const events = agentLoop([prompt], context, config, undefined, streamFn);
	const messages = await events.result();
	const results = messages.flatMap((m) =>
		m.role === "toolResult"
			? [{ isError: m.isError, text: m.content.map((c) => (c.type === "text" ? c.text : "")).join("") }]
			: [],
	);
	return { executed, results, turns: turn };
}

/** A `file` call as a model writes it: a long text inside queries[]. */
const longCall = (textLength: number) => `{"queries":[{"path":"report.md","text":"${"x".repeat(textLength)}"}]}`;

describe("tool calls cut by the model's output limit", () => {
	it("tells the model the limit, how much was cut off, and to send smaller calls", async () => {
		const cutText = longCall(15_000).slice(0, 14_000);
		const call = finalizedCall("t1", "file", cutText);
		expect(call.argumentsError).toBeDefined();

		const { executed, results, turns } = await runScriptedTurn(assistant([call], "length", 16_000));

		expect(executed).toEqual([]);
		expect(turns).toBe(2);
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("output limit (16000 tokens)");
		expect(results[0].text).toContain("cut off after 14000 characters");
		expect(results[0].text).toContain("smaller pieces");
		// The old text asked for "complete arguments", which repeats the oversized call.
		expect(results[0].text).not.toContain("complete arguments");
	});

	it("keeps every character the model sent on the persisted tool call", async () => {
		const cutText = longCall(15_000).slice(0, 14_000);
		const call = finalizedCall("t1", "file", cutText);
		// The model-facing echo is bounded, so the whole text must live on the call itself.
		expect(call.argumentsError!.length).toBeLessThan(cutText.length / 4);
		expect(call.rawArguments).toBe(cutText);
	});

	it("does not run a complete call that shares a cut-off response, and says why", async () => {
		const complete = finalizedCall("t1", "file", longCall(10));
		expect(complete.argumentsError).toBeUndefined();
		const cut = finalizedCall("t2", "file", longCall(5_000).slice(0, 4_000));

		const { executed, results } = await runScriptedTurn(assistant([complete, cut], "length", 16_000));

		expect(executed).toEqual([]);
		expect(results).toHaveLength(2);
		expect(results[0].text).toContain("cannot be confirmed complete");
		expect(results[0].text).toContain("output limit (16000 tokens)");
		expect(results[1].text).toContain("in the middle of this call");
	});

	it("omits the token count when the provider reported none", async () => {
		const call = finalizedCall("t1", "file", longCall(500).slice(0, 300));
		const { results } = await runScriptedTurn(assistant([call], "length", 0));
		expect(results[0].text).toContain("the model's output limit in the middle");
	});
});

describe("tool calls whose arguments are not valid JSON", () => {
	it("names the missing closing brackets and asks for smaller calls", async () => {
		// A long edit that closes edits and the query but forgets the end of `queries` and the envelope.
		const missingEnd = longCall(8_000).slice(0, -2);
		const call = finalizedCall("t1", "file", missingEnd);

		const { executed, results } = await runScriptedTurn(assistant([call], "toolUse", 3_000));

		expect(executed).toEqual([]);
		expect(results[0].isError).toBe(true);
		expect(results[0].text).toContain("2 unclosed brackets; it needs `]}` at the end");
		expect(results[0].text).toContain("split it into several smaller calls");
		expect(call.rawArguments).toBe(missingEnd);
	});

	it("names a bracket that closes the wrong kind", async () => {
		const call = finalizedCall("t1", "file", '{"queries":[{"path":"a","text":"b"}}');
		const { results } = await runScriptedTurn(assistant([call], "toolUse", 50));
		expect(results[0].text).toContain("Bracket mismatch: `}` at position 35 where `]` was expected");
	});
});
