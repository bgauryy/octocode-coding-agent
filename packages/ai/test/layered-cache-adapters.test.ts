import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { stream as bedrockStream } from "../src/api/bedrock-converse-stream.ts";
import { stream as completionsStream } from "../src/api/openai-completions.ts";
import { generateImages } from "../src/api/openrouter-images.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { ImageModel, Model, StreamOptions } from "../src/types.ts";
import { resolveLayeredCacheRetention } from "../src/utils/cache-policy.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const layered: StreamOptions = { cacheRetention: "short", instructionCacheRetention: "long" };
const context = normalizeContext({
	systemPrompt: "Stable agent instructions",
	messages: [{ role: "user", content: "A changing task", timestamp: 0 }],
	tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
});

class Captured extends Error {}

async function capture<T>(run: (onPayload: (value: unknown) => never) => { result(): Promise<unknown> }): Promise<T> {
	let payload: T | undefined;
	await run((value) => {
		payload = value as T;
		throw new Captured();
	}).result();
	if (!payload) throw new Error("payload not captured");
	return payload;
}

describe("resolveLayeredCacheRetention", () => {
	it("defaults instructions to the history retention and keeps explicit layers", () => {
		expect(resolveLayeredCacheRetention({ cacheRetention: "long" })).toEqual({ history: "long", instructions: "long" });
		expect(resolveLayeredCacheRetention(layered)).toEqual({ history: "short", instructions: "long" });
		expect(resolveLayeredCacheRetention({ cacheRetention: "none", instructionCacheRetention: "long" })).toEqual({
			history: "none",
			instructions: "none",
		});
	});
	it("keeps long history behind short instructions; ordering is each adapter's rule", () => {
		const env = { OCTOCODE_CACHE_RETENTION: "long", OCTOCODE_INSTRUCTION_CACHE_RETENTION: "short" };
		expect(resolveLayeredCacheRetention({ env })).toEqual({ history: "long", instructions: "short" });
	});
});

describe("layered retention on adapters with explicit breakpoints", () => {
	it("Bedrock writes the system point for 1h and the history point for 5m", async () => {
		const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
		const payload = await capture<{
			system: { cachePoint?: { ttl?: string } }[];
			messages: { content: { cachePoint?: { ttl?: string } }[] }[];
		}>((onPayload) => bedrockStream(model, context, { ...layered, onPayload }));
		const systemPoint = payload.system.find((block) => block.cachePoint)?.cachePoint;
		const historyPoint = payload.messages.at(-1)?.content.find((block) => block.cachePoint)?.cachePoint;
		expect(systemPoint?.ttl).toBeDefined();
		expect(historyPoint).toBeDefined();
		expect(historyPoint?.ttl).toBeUndefined();
	});

	it("OpenRouter Claude marks system and tools for 1h and the last message for 5m", async () => {
		const model = getBuiltinModel("openrouter", "anthropic/claude-fable-5.1:batch");
		const payload = await capture<{
			messages: { role: string; content: { cache_control?: { ttl?: string } }[] | string }[];
			tools: { cache_control?: { ttl?: string } }[];
		}>((onPayload) => completionsStream(model, context, { ...layered, apiKey: "test-key", onPayload }));
		const system = payload.messages.find((message) => message.role === "system" || message.role === "developer")!;
		const last = payload.messages.at(-1)!;
		expect((system.content as { cache_control?: unknown }[])[0].cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
		expect(payload.tools.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect((last.content as { cache_control?: unknown }[])[0].cache_control).toEqual({ type: "ephemeral" });
	});

	it("Anthropic caps an env-only short-instruction/long-history pair instead of failing", async () => {
		const model: Model<"anthropic-messages"> = getBuiltinModel("anthropic", "claude-haiku-4-5");
		const env = { OCTOCODE_CACHE_RETENTION: "long", OCTOCODE_INSTRUCTION_CACHE_RETENTION: "short" };
		const payload = await capture<{
			system: { cache_control?: { ttl?: string } }[];
			messages: { content: { cache_control?: { ttl?: string } }[] }[];
		}>((onPayload) => anthropicStream(model, context, { apiKey: "sk-ant-api-test", env, onPayload }));
		expect(payload.system[0].cache_control).toEqual({ type: "ephemeral" });
		expect(payload.messages.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
	});
});

describe("OpenRouter image usage", () => {
	it("keeps cached_tokens as reads and does not subtract writes from them", async () => {
		const model: ImageModel<"openrouter-images"> = {
			id: "image-model",
			name: "Image model",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.test/api/v1",
			type: "image",
			input: ["text"],
			output: ["image"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
		};
		const body = {
			id: "gen-1",
			choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
			usage: {
				prompt_tokens: 10_000,
				completion_tokens: 10,
				prompt_tokens_details: { cached_tokens: 4_000, cache_write_tokens: 3_000 },
			},
		};
		const result = await generateImages(
			model,
			{ input: [{ type: "text", text: "draw" }] },
			{
				apiKey: "test-key",
				maxRetries: 0,
				fetch: async () =>
					new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
			},
		);
		expect(result.errorMessage).toBeUndefined();
		expect(result.usage).toMatchObject({ input: 3_000, cacheRead: 4_000, cacheWrite: 3_000, totalTokens: 10_010 });
	});
});
