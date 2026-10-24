import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Message, SimpleStreamOptions, Tool, ToolResultMessage } from "../src/types.ts";
import { createEmptyUsage } from "../src/utils/assistant-message.ts";
import { supportsNativeToolLoading } from "../src/utils/tool-loading.ts";

// Wire shape of each OpenCode API family, captured through the provider dispatch (which adds the
// OpenCode session header) with no network. Retention matches coding-agent defaults: long instructions,
// short history.

afterEach(() => vi.unstubAllGlobals());

type Body = Record<string, unknown>;
interface Captured {
	url: string;
	headers: Headers;
	body: Body;
}

const SESSION = "ses_opencode_cache";
const readTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const grepTool: Tool = { ...readTool, name: "grep", description: "Search files" };
const defaults: SimpleStreamOptions = {
	apiKey: "test-only-key",
	sessionId: SESSION,
	maxRetries: 0,
	cacheRetention: "short",
	instructionCacheRetention: "long",
};

async function capture(
	model: ReturnType<typeof getBuiltinModel>,
	messages: Message[],
	options: SimpleStreamOptions = {},
	tools: Tool[] = [readTool],
): Promise<Captured> {
	const requests: Request[] = [];
	const fetchStub: typeof fetch = async (input, init) => {
		requests.push(new Request(input, init));
		return Response.json({ error: { message: "intercepted" } }, { status: 400 });
	};
	// The Google SDK ignores the fetch option, so the global stub covers it.
	vi.stubGlobal("fetch", fetchStub);
	await streamSimple(
		model,
		{ systemPrompt: "Stable agent instructions", tools, messages },
		{ ...defaults, ...options, ...(model.api === "google-generative-ai" ? {} : { fetch: fetchStub }) },
	).result();
	expect(requests).toHaveLength(1);
	const [request] = requests;
	return { url: request.url, headers: request.headers, body: (await request.json()) as Body };
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

function assistantFor(
	model: ReturnType<typeof getBuiltinModel>,
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 0,
	};
}

const toolResult = (id: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text: "file contents" }],
	isError: false,
	timestamp: 0,
});

/**
 * Drops `cache_control` and expands string content to its single text block: Anthropic renders both forms as
 * the same tokens, and the adapter switches a message to blocks only to carry a marker.
 */
function withoutCacheMarkers(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value), (key, child) => {
		if (key === "cache_control") return undefined;
		if (key === "content" && typeof child === "string") return [{ type: "text", text: child }];
		return child;
	});
}

describe("OpenCode Anthropic Messages (Claude)", () => {
	it.each([
		["opencode/claude-sonnet-5-5", getBuiltinModel("opencode", "claude-sonnet-5-5"), "inference/anthropic"],
		["opencode-go/claude-haiku-5-5", getBuiltinModel("opencode-go", "claude-haiku-5-5"), "inference/go/anthropic"],
	] as const)("%s writes 1h instruction and 5m history markers", async (_name, model, path) => {
		const endpoint = `https://opencode.ai/${path}/v1/messages`;
		const { url, headers, body } = await capture(model, [user("Inspect the code")]);
		expect(url.startsWith(endpoint)).toBe(true);
		expect(headers.get("x-opencode-session")).toBe(SESSION);
		expect(headers.get("x-api-key")).toBe("test-only-key");
		// No generic affinity headers: OpenCode routes on its own session header.
		expect(headers.get("x-session-affinity")).toBeNull();
		const system = body.system as { cache_control?: unknown }[];
		const tools = body.tools as { cache_control?: unknown }[];
		const messages = body.messages as { content: { cache_control?: unknown }[] }[];
		expect(system.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(tools.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(messages.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("sends no cache markers for none but keeps session routing", async () => {
		const model = getBuiltinModel("opencode", "claude-sonnet-5-5");
		const { headers, body } = await capture(model, [user("Inspect the code")], { cacheRetention: "none" });
		expect(JSON.stringify(body)).not.toContain("cache_control");
		expect(headers.get("x-opencode-session")).toBe(SESSION);
	});

	it("keeps tool changes top-level: mid-conversation tool loading is not native through OpenCode", () => {
		const model = getBuiltinModel("opencode", "claude-sonnet-5-5");
		expect(model.compat?.supportsMidConvoSystemMessages).toBe(true);
		expect(model.compat?.supportsMidConvoToolChanges).toBeUndefined();
		expect(supportsNativeToolLoading(model)).toBe(false);
	});

	it("keeps the cached prefix byte-identical across consecutive requests", async () => {
		const model = getBuiltinModel("opencode", "claude-sonnet-5-5");
		const call = { type: "toolCall" as const, id: "toolu_01", name: "read", arguments: { path: "a.ts" } };
		const thinking = { type: "thinking" as const, thinking: "Read it first.", thinkingSignature: "sig-1" };
		const turn1: Message[] = [user("Inspect the code"), assistantFor(model, [thinking, call]), toolResult("toolu_01")];
		const turn2: Message[] = [
			...turn1,
			assistantFor(model, [{ type: "text", text: "It exports one function." }]),
			user("Now explain it"),
		];
		const first = (await capture(model, turn1)).body;
		const second = (await capture(model, turn2)).body;
		const { messages: firstMessages, ...firstRest } = first;
		const { messages: secondMessages, ...secondRest } = second;
		// Instructions, tools and request options do not move.
		expect(JSON.stringify(secondRest)).toBe(JSON.stringify(firstRest));
		const previous = firstMessages as unknown[];
		expect(JSON.stringify(withoutCacheMarkers((secondMessages as unknown[]).slice(0, previous.length)))).toBe(
			JSON.stringify(withoutCacheMarkers(previous)),
		);
		// The thinking signature is replayed unchanged, so the prefix the gateway forwards is stable.
		expect(JSON.stringify(secondMessages)).toContain('"signature":"sig-1"');
	});

	it("rewrites the top-level tool list when a tool is added (full cache loss, documented)", async () => {
		const model = getBuiltinModel("opencode", "claude-sonnet-5-5");
		const messages = [user("Inspect the code")];
		const before = (await capture(model, messages)).body;
		const after = (await capture(model, messages, {}, [readTool, grepTool])).body;
		expect((after.tools as unknown[]).length).toBe((before.tools as unknown[]).length + 1);
		expect(JSON.stringify(after)).not.toContain("tool_addition");
	});
});

describe("OpenCode Anthropic Messages (non-Claude)", () => {
	it("replays empty-signature thinking for qwen3.8-flash", async () => {
		const model = getBuiltinModel("opencode", "qwen3.8-flash");
		expect(model.compat?.allowEmptySignature).toBe(true);
		const messages: Message[] = [
			user("Inspect the code"),
			assistantFor(model, [
				{ type: "thinking", thinking: "Plan.", thinkingSignature: "" },
				{ type: "text", text: "Done." },
			]),
			user("Continue"),
		];
		const { body } = await capture(model, messages, { reasoning: "high" });
		const assistant = (body.messages as { role: string; content: { type: string }[] }[]).find(
			(message) => message.role === "assistant",
		);
		expect(assistant?.content[0]).toMatchObject({ type: "thinking", thinking: "Plan.", signature: "" });
	});
});

describe("OpenCode OpenAI Responses", () => {
	it.each([
		["opencode/gpt-6-luna", getBuiltinModel("opencode", "gpt-6-luna")],
		["opencode-go/gpt-6-luna", getBuiltinModel("opencode-go", "gpt-6-luna")],
	] as const)(
		"%s routes by prompt_cache_key and session headers without unverified TTL fields",
		async (_name, model) => {
			for (const cacheRetention of ["short", "long"] as const) {
				const { headers, body } = await capture(model, [user("Inspect the code")], { cacheRetention });
				expect(headers.get("x-opencode-session")).toBe(SESSION);
				expect(headers.get("x-client-request-id")).toBe(SESSION);
				// openai-nosession: no `session_id` header for the gateway.
				expect(headers.get("session_id")).toBeNull();
				expect(body.prompt_cache_key).toBe(SESSION);
				expect(body.store).toBe(false);
				expect(body.prompt_cache_retention).toBeUndefined();
				expect(body.prompt_cache_options).toBeUndefined();
				expect(JSON.stringify(body.input)).not.toContain("prompt_cache_breakpoint");
			}
			// Tools ride in an `additional_tools` input item, so later loads keep the prefix.
			expect(supportsNativeToolLoading(model)).toBe(true);
		},
	);
});

describe("OpenCode Chat Completions", () => {
	it("routes kimi-k3 by session header and sends prompt_cache_key only for long retention", async () => {
		const model = getBuiltinModel("opencode", "kimi-k3");
		const short = await capture(model, [user("Inspect the code")]);
		expect(short.headers.get("x-opencode-session")).toBe(SESSION);
		expect(short.body.prompt_cache_key).toBeUndefined();
		expect(short.body.stream_options).toEqual({ include_usage: true });
		const long = await capture(model, [user("Inspect the code")], { cacheRetention: "long" });
		expect(long.body.prompt_cache_key).toBe(SESSION);
		// Only api.openai.com, or explicit metadata, receives the OpenAI-only retention field.
		expect(long.body.prompt_cache_retention).toBeUndefined();
	});
});

describe("OpenCode Google", () => {
	it("routes gemini by session header with implicit caching only", async () => {
		const model = getBuiltinModel("opencode", "gemini-3.5-flash");
		const { url, headers, body } = await capture(model, [user("Inspect the code")]);
		expect(url).toContain("https://opencode.ai/inference/google/v1beta/models/gemini-3.5-flash:");
		expect(headers.get("x-opencode-session")).toBe(SESSION);
		expect(body.cachedContent).toBeUndefined();
	});
});
