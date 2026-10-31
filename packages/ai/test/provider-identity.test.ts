import { describe, expect, it } from "vitest";
import { getCompat } from "../src/api/openai-completions/compat.ts";
import { convertMessages } from "../src/api/openai-completions/messages.ts";
import { getGemini25Family } from "../src/api/google-shared/params.ts";
import { buildChatPayload } from "../src/api/mistral-conversations/request.ts";
import { DEFAULT_TOOL_CALL_ID_MAX_LENGTH, sanitizeToolCallId } from "../src/api/tool-call-id.ts";
import { apiKeyEnvVars, findApiKeyEnvVars } from "../src/auth/api-key-env-vars.ts";
import { findEnvKeys } from "../src/env-api-keys.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Model, ToolResultMessage } from "../src/types.ts";
import { getProviderCapabilities } from "../src/utils/provider-capabilities.ts";
import { isOpenRouterModel, matchesHost } from "../src/utils/provider-host.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

describe("sanitizeToolCallId", () => {
	it("replaces invalid characters and caps the length", () => {
		expect(sanitizeToolCallId("call:1/é")).toBe("call_1__");
		expect(sanitizeToolCallId("a".repeat(100))).toHaveLength(DEFAULT_TOOL_CALL_ID_MAX_LENGTH);
		expect(sanitizeToolCallId("abcdef", 3)).toBe("abc");
	});

	it("can trim trailing underscores after the cap", () => {
		expect(sanitizeToolCallId("ab+", 64, { trimTrailingUnderscores: true })).toBe("ab");
		expect(sanitizeToolCallId("ab+")).toBe("ab_");
	});
});

describe("OpenAI Chat Completions tool-call ids", () => {
	const base = { api: "openai-completions", baseUrl: "https://example.invalid/v1", reasoning: false } as const;
	function model(provider: string): Model<"openai-completions"> {
		return {
			...base,
			id: "m",
			name: "m",
			provider,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
	}
	function toolCallIds(m: Model<"openai-completions">, id: string): string[] {
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: id,
			toolName: "t",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 0,
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "t", arguments: {} }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "other",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		};
		const context = normalizeContext({
			messages: [{ role: "user", content: "hi", timestamp: 0 }, assistant, toolResult],
		});
		return convertMessages(m, context, getCompat(m))
			.filter((message) => message.role === "tool")
			.map((message) => (message as { tool_call_id: string }).tool_call_id);
	}

	it("caps the limit only where the provider declares one", () => {
		expect(getCompat(model("openai")).toolCallIdMaxLength).toBe(40);
		expect(getCompat(model("groq")).toolCallIdMaxLength).toBeUndefined();
	});

	it("applies the compat limit to plain ids", () => {
		const long = "x".repeat(60);
		expect(toolCallIds(model("openai"), long)[0]).toHaveLength(40);
		expect(toolCallIds(model("groq"), long)[0]).toHaveLength(60);
	});

	it("fits pipe-separated ids into 40 characters with a hash and keeps short ones readable", () => {
		expect(toolCallIds(model("groq"), "call_1|item+1")[0]).toBe("call_1_item_1");
		const hashed = toolCallIds(model("groq"), `call_1|${"i".repeat(80)}`)[0];
		expect(hashed.length).toBeLessThanOrEqual(40);
		expect(hashed).toMatch(/^call_1_[a-z0-9]{8}$/);
	});
});

describe("host detection", () => {
	it("matches the exact hostname only", () => {
		expect(matchesHost("https://openrouter.ai/api/v1", "openrouter.ai")).toBe(true);
		expect(matchesHost("https://proxy.example/openrouter.ai/v1", "openrouter.ai")).toBe(false);
		expect(matchesHost("not a url", "openrouter.ai")).toBe(false);
	});

	it("recognizes OpenRouter by provider id or host, not by lookalike path", () => {
		expect(isOpenRouterModel({ provider: "openrouter", baseUrl: "http://localhost:1/v1" })).toBe(true);
		expect(isOpenRouterModel({ provider: "custom", baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
		expect(isOpenRouterModel({ provider: "custom", baseUrl: "https://proxy.example/openrouter.ai/v1" })).toBe(false);
	});
});

describe("provider capabilities", () => {
	it("defaults to no quirks and lists each provider's own", () => {
		expect(getProviderCapabilities("groq")).toMatchObject({ copilotDynamicHeaders: false, acceptsReasoningOff: true });
		expect(getProviderCapabilities("github-copilot")).toMatchObject({
			copilotDynamicHeaders: true,
			anthropicBearerAuth: true,
			acceptsReasoningOff: false,
		});
		expect(getProviderCapabilities("xai")).toMatchObject({
			grokConversationHeader: true,
			alwaysIncludeEncryptedReasoning: true,
		});
		expect(getProviderCapabilities("cerebras").bodylessContextOverflow).toBe(true);
		expect(getProviderCapabilities("opencode-go").claudeEffortLimits).toBe(true);
	});
});

describe("Gemini 2.5 families", () => {
	it.each([
		["gemini-2.5-pro", "pro"],
		["gemini-2.5-flash", "flash"],
		["gemini-2.5-flash-lite", "flash-lite"],
		["gemini-2.5-flash-lite-preview-06-17", "flash-lite"],
		["publishers/google/models/gemini-2.5-flash-preview-05-20", "flash"],
		["gemini-3-pro-preview", undefined],
		["gemini-2.0-flash", undefined],
	])("maps %s to %s regardless of table order", (id, family) => {
		expect(getGemini25Family(id)).toBe(family);
	});
});

describe("API-key environment variables", () => {
	it("serves provider auth and env discovery from one table", () => {
		const env = { GROQ_API_KEY: "k", GEMINI_API_KEY: "g" };
		expect(findEnvKeys("groq", env)).toEqual(apiKeyEnvVars("groq"));
		expect(findEnvKeys("google", env)).toEqual(["GEMINI_API_KEY"]);
		expect(apiKeyEnvVars("google")).toEqual(["GOOGLE_API_KEY", "GEMINI_API_KEY"]);
		expect(findApiKeyEnvVars("unknown-provider")).toBeUndefined();
	});
});

describe("Mistral non-vision placeholders", () => {
	it("uses the shared tool-image placeholder for tool results the model cannot see", () => {
		const model = getBuiltinModel("mistral", "mistral-large-latest") as Model<"mistral-conversations"> | undefined;
		if (!model) throw new Error("mistral model missing from the catalog");
		const blind = { ...model, input: ["text"] as Model<"mistral-conversations">["input"] };
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "abcdefghi",
			toolName: "shot",
			content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			isError: true,
			timestamp: 0,
		};
		const context = normalizeContext({ messages: [{ role: "user", content: "x", timestamp: 0 }, result] });
		const payload = buildChatPayload(blind, context, context.messages);
		const tool = payload.messages.find((m) => m.role === "tool") as { content: Array<{ text: string }> };
		expect(tool.content[0].text).toBe("[tool error] (tool image omitted: model does not support images)");
	});
});
