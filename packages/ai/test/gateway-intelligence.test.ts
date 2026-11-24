import { describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { applyReportedCost, reportedCostUsd, safeUsd } from "../src/api/openai-completions/openrouter-cost.ts";
import { routerMetadataDiagnostic } from "../src/api/openai-completions/openrouter-router.ts";
import { normalizeContext } from "../src/compat.ts";
import { OpenRouterAutoRouterSchema } from "../src/providers/compat-schema/common.ts";
import { ProviderCompatSchema } from "../src/providers/compat-schema.ts";
import type { Model } from "../src/types.ts";
import { Value } from "typebox/value";
import { completionsResponse, mockCompletionsFetch } from "./completions-fetch-fixture.ts";

let chunks: unknown[] = [];
let sent: { body: Record<string, unknown>; headers: Record<string, string> } | undefined;

mockCompletionsFetch<Record<string, unknown>>((body, request) => {
	sent = { body, headers: Object.fromEntries(new Headers(request.headers).entries()) };
	return completionsResponse(chunks);
});

function model(id: string, compat?: Model<"openai-completions">["compat"], cost = { input: 0, output: 0 }) {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { ...cost, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		compat,
	} satisfies Model<"openai-completions">;
}

const text = { id: "c1", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] };
const stop = { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
const usageChunk = (usage: object, extra: object = {}) => ({ id: "c1", choices: [], usage, ...extra });

async function run(m: Model<"openai-completions">) {
	sent = undefined;
	return streamOpenAICompletions(
		m,
		normalizeContext({ messages: [{ role: "user", content: "secret prompt", timestamp: 0 }] }),
		{
			apiKey: "k",
			sessionId: "s1",
		},
	).result();
}

describe("OpenRouter authoritative cost", () => {
	it("charges an auto router the reported cost and keeps token buckets", async () => {
		chunks = [
			text,
			stop,
			usageChunk({
				prompt_tokens: 100,
				completion_tokens: 20,
				total_tokens: 120,
				prompt_tokens_details: { cached_tokens: 40 },
				cost: 0.0123,
			}),
		];
		const message = await run(model("openrouter/auto"));
		expect(message.stopReason).toBe("stop");
		expect(message.usage.cost.total).toBeCloseTo(0.0123, 12);
		const { input, output, cacheRead, cacheWrite } = message.usage.cost;
		expect(input + output + cacheRead + cacheWrite).toBeCloseTo(0.0123, 12);
		expect(message.usage).toMatchObject({ input: 60, output: 20, cacheRead: 40, totalTokens: 120 });
	});

	it("splits an unpriced model's cost by the upstream prompt and completion cost", async () => {
		chunks = [
			text,
			stop,
			usageChunk({
				prompt_tokens: 10,
				completion_tokens: 10,
				cost: 0.4,
				cost_details: { upstream_inference_prompt_cost: 0.1, upstream_inference_completions_cost: 0.3 },
			}),
		];
		const { usage } = await run(model("openrouter/auto"));
		expect(usage.cost.input).toBeCloseTo(0.1, 12);
		expect(usage.cost.output).toBeCloseTo(0.3, 12);
	});

	it("adds the upstream charge of a BYOK request to OpenRouter's fee", () => {
		expect(reportedCostUsd({ cost: 0.01, is_byok: true, cost_details: { upstream_inference_cost: 0.5 } })).toBeCloseTo(
			0.51,
			12,
		);
		expect(reportedCostUsd({ cost: 0.01, cost_details: { upstream_inference_cost: 0.5 } })).toBe(0.01);
	});

	it("rejects negative, non-finite and non-numeric costs", () => {
		for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "x", "", null, {}, undefined])
			expect(safeUsd(bad)).toBeUndefined();
		expect(safeUsd("0.25")).toBe(0.25);
		expect(safeUsd(0)).toBe(0);
	});

	it("falls back to catalog rates when no cost is reported", async () => {
		chunks = [text, stop, usageChunk({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 })];
		const { usage } = await run(model("vendor/model", undefined, { input: 2, output: 4 }));
		expect(usage.cost).toMatchObject({ input: 2, output: 4, total: 6 });
	});

	it("falls back to catalog rates when the reported cost is malformed", async () => {
		chunks = [text, stop, usageChunk({ prompt_tokens: 1_000_000, completion_tokens: 0, cost: -3 })];
		const { usage } = await run(model("vendor/model", undefined, { input: 2, output: 4 }));
		expect(usage.cost.total).toBe(2);
	});

	it("uses the reported cost scaled over catalog rates when both exist", () => {
		const usage = {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0, total: 4 },
		};
		applyReportedCost(usage, {}, 2);
		expect(usage.cost).toMatchObject({ input: 0.5, output: 1.5, total: 2 });
	});

	it("ignores a cost field from a non-OpenRouter endpoint", async () => {
		chunks = [text, stop, usageChunk({ prompt_tokens: 1_000_000, completion_tokens: 0, cost: 99 })];
		const other = {
			...model("vendor/model", undefined, { input: 2, output: 4 }),
			provider: "local",
			baseUrl: "http://127.0.0.1:9/v1",
		};
		const { usage } = await run(other);
		expect(usage.cost.total).toBe(2);
	});
});

describe("OpenRouter Auto Router controls", () => {
	const controls = {
		allowed_models: ["anthropic/*"],
		excluded_models: ["anthropic/claude-3-haiku"],
		cost_tier: "low" as const,
	};

	it("sends the auto-router plugin and asks for metadata", async () => {
		chunks = [text, stop, usageChunk({ prompt_tokens: 1, completion_tokens: 1 })];
		const m = model("openrouter/auto", { openRouterAutoRouter: controls });
		await run(m);
		expect(sent?.body.plugins).toEqual([{ id: "auto-router", ...controls }]);
		expect(sent?.headers["x-openrouter-metadata"]).toBe("enabled");
		expect(m.compat?.openRouterAutoRouter).toEqual(controls);
	});

	it.each([
		["openrouter/auto-beta", "auto-beta-router"],
		["openrouter/auto-code", "auto-router"],
	])("uses the official plugin id for %s", async (id, pluginId) => {
		chunks = [text, stop, usageChunk({ prompt_tokens: 1, completion_tokens: 1 })];
		await run(model(id, { openRouterAutoRouter: controls }));
		expect(sent?.body.plugins).toEqual([{ id: pluginId, ...controls }]);
		expect(sent?.headers["x-openrouter-metadata"]).toBe("enabled");
	});

	it("does not send the plugin on an ordinary model", async () => {
		chunks = [text, stop];
		await run(model("anthropic/claude-sonnet-4.5", { openRouterAutoRouter: controls }));
		expect(sent?.body.plugins).toBeUndefined();
		expect(sent?.headers["x-openrouter-metadata"]).toBeUndefined();
	});

	it("lets metadata be turned off", async () => {
		chunks = [text, stop];
		await run(model("openrouter/auto", { openRouterAutoRouter: { metadata: false } }));
		expect(sent?.headers["x-openrouter-metadata"]).toBeUndefined();
	});

	it("records a sanitized routing diagnostic and never prompt text", async () => {
		chunks = [
			text,
			stop,
			usageChunk(
				{ prompt_tokens: 1, completion_tokens: 1 },
				{
					openrouter_metadata: {
						requested: "openrouter/auto",
						strategy: "auto",
						attempt: 1,
						summary: "user asked about secret prompt",
						endpoints: {
							total: 3,
							available: [
								{ provider: "Anthropic", model: "anthropic/claude", selected: true, prompt: "secret prompt" },
							],
						},
						pipeline: [{ type: "plugin", name: "auto-router", data: { prompt: "secret prompt" } }],
					},
				},
			),
		];
		const message = await run(model("openrouter/auto"));
		const diagnostic = message.diagnostics?.find((entry) => entry.type === "openrouter-router");
		expect(diagnostic?.details).toMatchObject({
			requested: "openrouter/auto",
			strategy: "auto",
			selected: [{ provider: "Anthropic", model: "anthropic/claude", selected: true }],
		});
		expect(JSON.stringify(message.diagnostics)).not.toContain("secret prompt");
	});

	it("returns nothing for absent or empty metadata", () => {
		expect(routerMetadataDiagnostic(undefined)).toBeUndefined();
		expect(routerMetadataDiagnostic({})).toBeUndefined();
	});

	it("validates controls in the schemas", () => {
		expect(Value.Check(OpenRouterAutoRouterSchema, controls)).toBe(true);
		expect(Value.Check(OpenRouterAutoRouterSchema, { cost_tier: "cheap" })).toBe(false);
		expect(
			Value.Check(ProviderCompatSchema, { openRouterAutoRouter: controls, vercelGatewayRouting: { sort: "cost" } }),
		).toBe(true);
	});
});
