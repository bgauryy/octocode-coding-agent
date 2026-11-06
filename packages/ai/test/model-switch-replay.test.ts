/**
 * Switching models mid-session replays one transcript to another provider. These tests capture the request each adapter
 * would send (no network) and check what survives the switch: text, tool calls paired with their results under ids
 * the target accepts, and no thinking or reasoning from the previous model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fitToolCallId } from "../src/api/tool-call-id.ts";
import { streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Message, Model, StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type Payload = Record<string, any>;

class Captured extends Error {}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
	source: Pick<Model<any>, "api" | "provider" | "id">,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: source.api,
		provider: source.provider,
		model: source.id,
		usage,
		stopReason,
		timestamp: 1,
	};
}

function toolResult(toolCallId: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

async function capture(model: Model<any>, messages: Message[], apiKey: string, options: StreamOptions = {}) {
	let payload: Payload | undefined;
	const result = await streamSimple(
		model,
		normalizeContext({
			systemPrompt: "You are a test agent.",
			messages,
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			],
		}),
		{
			apiKey,
			sessionId: "switch-session",
			maxRetries: 0,
			fetch: async () => Promise.reject(new Error("network is forbidden")),
			...options,
			onPayload: (value) => {
				payload = value as Payload;
				throw new Captured();
			},
		},
	).result();
	if (!payload) throw new Error(`payload not captured: ${result.errorMessage}`);
	return payload;
}

const anthropic = () => getBuiltinModel("anthropic", "claude-haiku-4-5");
const openai = () => getBuiltinModel("openai", "gpt-6-luna");
const bedrock = () => getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

/** Every Anthropic content block of `type` in the request's messages. */
function anthropicBlocks(payload: Payload, type: string): Payload[] {
	return (payload.messages as Payload[]).flatMap((message) =>
		Array.isArray(message.content) ? message.content.filter((block: Payload) => block.type === type) : [],
	);
}

beforeEach(() => {
	for (const name of [
		"OCTOCODE_CACHE_RETENTION",
		"OCTOCODE_INSTRUCTION_CACHE_RETENTION",
		"OCTOCODE_PROMPT_CACHE_KEY",
	]) {
		vi.stubEnv(name, undefined);
	}
});
afterEach(() => vi.unstubAllEnvs());

describe("switching from Anthropic to OpenAI Responses", () => {
	it("keeps the reply and the paired tool call, and drops the signed thinking", async () => {
		const history: Message[] = [
			{ role: "user", content: "Read a.ts", timestamp: 0 },
			assistant(anthropic(), [
				{ type: "thinking", thinking: "SECRET-ANTHROPIC-THOUGHT", thinkingSignature: "sig-anthropic" },
				{ type: "text", text: "Reading it now." },
				{ type: "toolCall", id: "toolu_01AbCdEf", name: "read", arguments: { path: "a.ts" } },
			]),
			toolResult("toolu_01AbCdEf", "export const a = 1;"),
			assistant(anthropic(), [{ type: "text", text: "a.ts exports a." }], "stop"),
			{ role: "user", content: "Now on OpenAI: what does it export?", timestamp: 3 },
		];
		const payload = await capture(openai(), history, "sk-test");
		const items = payload.input as Payload[];
		const text = JSON.stringify(items);

		expect(items.some((item) => item.type === "reasoning")).toBe(false);
		expect(text).not.toContain("SECRET-ANTHROPIC-THOUGHT");
		expect(text).not.toContain("sig-anthropic");
		expect(text).toContain("Reading it now.");
		expect(text).toContain("a.ts exports a.");

		const call = items.find((item) => item.type === "function_call");
		const output = items.find((item) => item.type === "function_call_output");
		// A foreign call carries no Responses item id: OpenAI would validate it against its own reasoning items.
		expect(call).toMatchObject({ call_id: "toolu_01AbCdEf", name: "read" });
		expect(call?.id).toBeUndefined();
		expect(output?.call_id).toBe(call?.call_id);
	});
});

describe("switching from OpenAI Responses to Anthropic", () => {
	const itemId = `fc_${"0123456789abcdef".repeat(4)}`;

	it("rewrites the pipe-joined id into one Anthropic accepts, on the call and its result, and drops reasoning", async () => {
		const callId = `call_Xy12|${itemId}`;
		const reasoning = JSON.stringify({ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC-OPENAI" });
		const history: Message[] = [
			{ role: "user", content: "Read a.ts", timestamp: 0 },
			assistant(openai(), [
				{ type: "thinking", thinking: "", thinkingSignature: reasoning },
				{ type: "toolCall", id: callId, name: "read", arguments: { path: "a.ts" } },
			]),
			toolResult(callId, "export const a = 1;"),
			{ role: "user", content: "Continue on Claude.", timestamp: 3 },
		];
		const payload = await capture(anthropic(), history, "sk-ant-api-test");
		const [use] = anthropicBlocks(payload, "tool_use");
		const [result] = anthropicBlocks(payload, "tool_result");

		expect(use.id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		expect(result.tool_use_id).toBe(use.id);
		expect(anthropicBlocks(payload, "thinking")).toEqual([]);
		expect(anthropicBlocks(payload, "redacted_thinking")).toEqual([]);
		expect(JSON.stringify(payload)).not.toContain("ENC-OPENAI");
	});

	// GitHub Copilot's Responses endpoint can give parallel calls one call id and distinct item ids
	// (openai-completions/messages.ts says so where it replays them). Cut at 64 characters, both became one id.
	const copilot = { api: "openai-responses", provider: "github-copilot", id: "gpt-5.5" } as const;
	const sharedPrefix = `call_shared|${itemId}`;
	const first = `${sharedPrefix}AAAA`;
	const second = `${sharedPrefix}BBBB`;
	const parallel: Message[] = [
		{ role: "user", content: "Read both", timestamp: 0 },
		assistant(copilot, [
			{ type: "toolCall", id: first, name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: second, name: "read", arguments: { path: "b.ts" } },
		]),
		toolResult(first, "A"),
		toolResult(second, "B"),
		{ role: "user", content: "Continue on Claude.", timestamp: 3 },
	];

	it("keeps parallel calls whose ids share their first 64 characters distinct on Anthropic", async () => {
		const payload = await capture(anthropic(), parallel, "sk-ant-api-test");
		const uses = anthropicBlocks(payload, "tool_use");
		const results = anthropicBlocks(payload, "tool_result");
		expect(uses).toHaveLength(2);
		for (const use of uses) expect(use.id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		expect(new Set(uses.map((use) => use.id)).size).toBe(2);
		expect(results.map((result) => result.tool_use_id)).toEqual(uses.map((use) => use.id));
	});

	it("keeps them distinct on Bedrock Converse too", async () => {
		const payload = await capture(bedrock(), parallel, "unused");
		const blocks = (payload.messages as Payload[]).flatMap((message) => message.content as Payload[]);
		const uses = blocks.filter((block) => block.toolUse).map((block) => block.toolUse.toolUseId as string);
		const results = blocks.filter((block) => block.toolResult).map((block) => block.toolResult.toolUseId as string);
		expect(new Set(uses).size).toBe(2);
		for (const id of uses) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		expect(results).toEqual(uses);
	});

	it("replays the same transcript with the same ids, so the switched session's prefix stays cacheable", async () => {
		const a = anthropicBlocks(await capture(anthropic(), parallel, "sk-ant-api-test"), "tool_use");
		const b = anthropicBlocks(await capture(anthropic(), parallel, "sk-ant-api-test"), "tool_use");
		expect(b.map((use) => use.id)).toEqual(a.map((use) => use.id));
	});
});

describe("fitToolCallId", () => {
	it("leaves an id that fits as the sanitizer makes it", () => {
		expect(fitToolCallId("toolu_01AbC")).toBe("toolu_01AbC");
		expect(fitToolCallId("call:1/é")).toBe("call_1__");
		expect(fitToolCallId("a".repeat(64))).toBe("a".repeat(64));
	});

	it("ends an id that does not fit with a hash of the whole id, within the limit", () => {
		const a = fitToolCallId(`${"x".repeat(70)}A`);
		const b = fitToolCallId(`${"x".repeat(70)}B`);
		expect(a).toHaveLength(64);
		expect(b).toHaveLength(64);
		expect(a).not.toBe(b);
		expect(a).toMatch(/^x+_[a-z0-9]+$/);
		expect(fitToolCallId(`${"x".repeat(70)}A`)).toBe(a);
		expect(fitToolCallId("y".repeat(30), 8)).toHaveLength(8);
	});
});
