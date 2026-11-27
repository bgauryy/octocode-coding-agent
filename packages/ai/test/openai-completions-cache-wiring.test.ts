import { completionsResponse, mockCompletionsFetch } from "./completions-fetch-fixture.ts";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Model } from "../src/types.ts";

/**
 * The Chat Completions request path passes the transcript's tool cache boundary to the Anthropic-format markers, and a
 * Claude model sent without markers gets its one-time notice on the reply (the helpers themselves are covered in
 * `openai-completions-tool-cache-boundary.test.ts`).
 */

interface CapturedParams {
	tools?: Array<{ type: string; function: { name: string }; cache_control?: unknown }>;
}

const mockState = vi.hoisted(() => ({ lastParams: undefined as CapturedParams | undefined }));

mockCompletionsFetch((params: CapturedParams) => {
	mockState.lastParams = params;
	return completionsResponse({
		async *[Symbol.asyncIterator]() {
			yield {
				id: "chatcmpl-test",
				choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			};
		},
	});
});

function model(id: string, compat?: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "wiring-gateway",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4000,
		...(compat ? { compat } : {}),
	};
}

const tool = (name: string) => ({ name, description: name, parameters: Type.Object({}) });

async function send(
	target: Model<"openai-completions">,
	options: { toolCacheBoundary?: string } = {},
): Promise<{ params: CapturedParams; reply: AssistantMessage }> {
	mockState.lastParams = undefined;
	const reply = await streamOpenAICompletions(
		target,
		normalizeContext({
			systemPrompt: "System prompt",
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			tools: [tool("read"), tool("grep"), tool("agent")],
		}),
		{ apiKey: "test-key", cacheRetention: "short", ...options },
	).result();
	if (!mockState.lastParams) throw new Error("Expected payload to be captured");
	return { params: mockState.lastParams, reply };
}

const markedTools = (params: CapturedParams) =>
	(params.tools ?? []).filter((each) => each.cache_control !== undefined).map((each) => each.function.name);

describe("Chat Completions cache wiring", () => {
	beforeEach(() => {
		vi.stubEnv("OCTOCODE_CACHE_RETENTION", undefined);
		vi.stubEnv("OCTOCODE_INSTRUCTION_CACHE_RETENTION", undefined);
	});
	afterEach(() => vi.unstubAllEnvs());

	it("marks the end of the shared tools when the request names a tool cache boundary", async () => {
		const target = model("custom-qwen", { cacheControlFormat: "anthropic" });
		expect(markedTools((await send(target)).params)).toEqual(["agent"]);
		expect(markedTools((await send(target, { toolCacheBoundary: "agent" })).params)).toEqual(["grep"]);
	});

	it("adds the no-markers notice once to a Claude model's reply", async () => {
		const target = model("claude-wiring-test");
		const first = await send(target);
		expect(first.reply.diagnostics?.map((each) => each.details?.reason)).toContain("no_cache_markers");
		const second = await send(target);
		expect(second.reply.diagnostics?.map((each) => each.details?.reason) ?? []).not.toContain("no_cache_markers");
	});
});
