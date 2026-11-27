import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAnthropicMessagesCompatMetadata } from "../scripts/generate-models/anthropic.ts";
import { applyPromptCacheMetadata } from "../scripts/generate-models/metadata.ts";
import { addModelsDevGatewayModels } from "../scripts/generate-models/models-dev-gateways.ts";
import type { ModelsDevCatalog, ModelsDevModel } from "../scripts/generate-models/types.ts";
import { streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";

afterEach(() => vi.unstubAllGlobals());

const anthropicNpm = { npm: "@ai-sdk/anthropic" };
function entry(id: string, npm: { npm: string }, cost: ModelsDevModel["cost"]): ModelsDevModel {
	return {
		id,
		name: id,
		tool_call: true,
		reasoning: true,
		limit: { context: 200000, output: 64000 },
		cost,
		provider: npm,
	};
}
const claudeCost = { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 };
const catalog: ModelsDevCatalog = {
	opencode: {
		models: {
			"claude-sonnet-5-5": entry("claude-sonnet-5-5", anthropicNpm, claudeCost),
			"qwen3.8-flash": entry("qwen3.8-flash", anthropicNpm, {
				input: 0.15,
				output: 0.47,
				cache_read: 0.016,
				cache_write: 0.2,
			}),
			"gpt-6-luna": entry("gpt-6-luna", { npm: "@ai-sdk/openai" }, { input: 0.1, output: 0.5, cache_read: 0.01 }),
		},
	},
	"opencode-go": {
		models: {
			"claude-haiku-5-5": entry("claude-haiku-5-5", anthropicNpm, claudeCost),
			"minimax-m3": entry("minimax-m3", anthropicNpm, { input: 0.3, output: 1.2, cache_read: 0.06 }),
		},
	},
};

function generate(): Map<string, Model<Api>> {
	const models: Model<Api>[] = [];
	addModelsDevGatewayModels(catalog, models);
	for (const model of models) {
		applyAnthropicMessagesCompatMetadata(model);
		applyPromptCacheMetadata(model);
	}
	return new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
}

describe("OpenCode prompt-cache metadata (generator)", () => {
	const models = generate();

	it.each(["opencode/claude-sonnet-5-5", "opencode-go/claude-haiku-5-5"])(
		"%s declares Anthropic's 5m/1h cache lifetimes, which the gateway bills as cache_write_5m and cache_write_1h",
		(key) => {
			const model = models.get(key);
			expect(model?.promptCache).toEqual({ short: 300, long: 3600 });
			expect(
				(model?.compat as { supportsLongCacheRetention?: boolean } | undefined)?.supportsLongCacheRetention,
			).not.toBe(false);
		},
	);

	it.each(["opencode/qwen3.8-flash", "opencode-go/minimax-m3"])(
		"%s keeps 5m markers: only Claude holds an Anthropic 1h entry",
		(key) => {
			const model = models.get(key);
			expect(model?.api).toBe("anthropic-messages");
			expect(model?.compat).toMatchObject({ supportsLongCacheRetention: false });
			expect(model?.promptCache).toBeUndefined();
		},
	);

	it("keeps qwen3.8-flash empty-signature support alongside the cache flag", () => {
		expect(models.get("opencode/qwen3.8-flash")?.compat).toMatchObject({ allowEmptySignature: true });
	});

	it("leaves OpenAI Responses lifetimes undeclared until gateway TTL support is verified", () => {
		expect(models.get("opencode/gpt-6-luna")?.promptCache).toBeUndefined();
	});

	it("sends no ttl to a non-Claude Anthropic-protocol model even with long instructions", async () => {
		const model = models.get("opencode/qwen3.8-flash") as Model<"anthropic-messages">;
		let body: { system: { cache_control?: unknown }[] } | undefined;
		const fetchStub: typeof fetch = async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return Response.json({ error: { message: "intercepted" } }, { status: 400 });
		};
		await streamSimple(
			model,
			{ systemPrompt: "Stable agent instructions", messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ apiKey: "k", sessionId: "s", maxRetries: 0, instructionCacheRetention: "long", fetch: fetchStub },
		).result();
		expect(body?.system.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
	});
});

describe("OpenCode usage reporting", () => {
	const sse = (events: object[]) =>
		new Response(
			events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
			{
				headers: { "content-type": "text/event-stream" },
			},
		);

	it("reads cache reads and 1h writes from the gateway's Anthropic stream and prices them", async () => {
		const model = getBuiltinModel("opencode", "claude-sonnet-5-5");
		const usage = {
			input_tokens: 100,
			output_tokens: 1,
			cache_read_input_tokens: 8000,
			cache_creation_input_tokens: 3000,
			cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
		};
		const fetchStub: typeof fetch = async () =>
			sse([
				{
					type: "message_start",
					message: { id: "msg_1", type: "message", role: "assistant", model: model.id, content: [], usage },
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					// The gateway adds its own billing fields beside Anthropic's usage.
					usage: { ...usage, output_tokens: 5, cost: 0.0123, opencode: { billing_source: "balance" } },
				},
				{ type: "message_stop" },
			]);
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ apiKey: "k", sessionId: "s", maxRetries: 0, fetch: fetchStub },
		).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.usage).toMatchObject({
			input: 100,
			output: 5,
			cacheRead: 8000,
			cacheWrite: 3000,
			cacheWrite1h: 2000,
		});
		// 5m writes at the catalog write price, 1h writes at 2x input, as Anthropic and the gateway bill them.
		const { input, cacheRead, cacheWrite } = model.cost;
		const expected = (input * 100 + 10 * 5 + cacheRead * 8000 + cacheWrite * 1000 + input * 2 * 2000) / 1e6;
		expect(model.cost.output).toBe(10);
		expect(result.usage.cost.total).toBeCloseTo(expected, 10);
	});
});
