import { describe, expect, it } from "vitest";
import { processGoogleModels } from "../scripts/generate-models/processors.ts";
import type { ModelsDevModel } from "../scripts/generate-models/types.ts";
import { normalizeGoogleUsage } from "../src/api/google-shared/response.ts";
import { flattenChatModelCatalog } from "../src/model-catalog.ts";
import { calculateCost } from "../src/models/model-helpers.ts";
import type { Api, Model } from "../src/types.ts";

const source = (cost: ModelsDevModel["cost"]): ModelsDevModel => ({
	id: "gemini-2.5-pro",
	name: "Gemini 2.5 Pro",
	tool_call: true,
	reasoning: true,
	limit: { context: 1_048_576, output: 65_536 },
	cost,
});

const fromCatalog = (model: Model<Api>): Model<Api> =>
	(
		flattenChatModelCatalog(model.provider, {
			[model.api]: { [`chat:${model.id}`]: { ...model, type: "chat" } },
		}) as Record<string, Model<Api>>
	)[model.id];

describe("Vertex model pricing", () => {
	it("preserves upstream context tiers and excludes cache storage from token-write prices", () => {
		const [model] = processGoogleModels({
			"google-vertex": {
				models: {
					"gemini-2.5-pro": source({
						input: 1.25,
						output: 10,
						cache_read: 0.125,
						cache_write: 4.5,
						tiers: [
							{ tier: { type: "context", size: 200_000 }, input: 2.5, output: 15, cache_read: 0.25, cache_write: 4.5 },
						],
					}),
				},
			},
		});
		expect(model.cost).toEqual({
			input: 1.25,
			output: 10,
			cacheRead: 0.125,
			cacheWrite: 0,
			tiers: [{ inputTokensAbove: 200_000, input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }],
		});
		const standard = normalizeGoogleUsage({ promptTokenCount: 200_000, cachedContentTokenCount: 190_000 });
		expect(calculateCost(model, standard).total).toBeCloseTo(0.03625, 12);
		const long = normalizeGoogleUsage({
			promptTokenCount: 200_001,
			cachedContentTokenCount: 190_000,
			candidatesTokenCount: 10,
			thoughtsTokenCount: 5,
		});
		const cost = calculateCost(model, long);
		expect(cost.input).toBeCloseTo((10_001 * 2.5) / 1_000_000, 12);
		expect(cost.cacheRead).toBeCloseTo((190_000 * 0.25) / 1_000_000, 12);
		expect(cost.output).toBeCloseTo((15 * 15) / 1_000_000, 12);
	});

	it("counts tool-use prompt tokens as input, so the parts add up to the reported total", () => {
		const usage = normalizeGoogleUsage({
			promptTokenCount: 1000,
			cachedContentTokenCount: 400,
			toolUsePromptTokenCount: 500,
			candidatesTokenCount: 40,
			thoughtsTokenCount: 10,
			totalTokenCount: 1550,
		});
		expect(usage).toMatchObject({ input: 1100, cacheRead: 400, output: 50, totalTokens: 1550 });
		expect(usage.input + usage.cacheRead + usage.cacheWrite + usage.output).toBe(usage.totalTokens);
	});

	it.each([
		["gemini-2.5-pro", 1.25, 10, 0.125],
		["gemini-3.1-pro-preview", 2, 12, 0.2],
	] as const)(
		"shares missing-tier corrections between generated and older hydrated %s catalogs",
		(id, input, output, cacheRead) => {
			const [model] = processGoogleModels({
				"google-vertex": { models: { [id]: source({ input, output, cache_read: cacheRead }) } },
			});
			const legacy = { ...model, cost: { input, output, cacheRead, cacheWrite: 0 } };
			const normalized = fromCatalog(legacy);
			expect(normalized.cost.tiers).toEqual([
				{ inputTokensAbove: 200_000, input: input * 2, output: output * 1.5, cacheRead: cacheRead * 2, cacheWrite: 0 },
			]);
			expect(normalized.cost).toEqual(model.cost);
			expect(legacy.cost).toEqual({ input, output, cacheRead, cacheWrite: 0 });
			expect(fromCatalog(normalized)).toEqual(normalized);
		},
	);

	it("preserves explicit tiers, other providers, and custom prices", () => {
		const [model] = processGoogleModels({
			"google-vertex": { models: { "gemini-2.5-pro": source({ input: 1.25, output: 10, cache_read: 0.125 }) } },
		});
		const legacy = { ...model, cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } };
		const explicit = { ...legacy, cost: { ...legacy.cost, tiers: [{ inputTokensAbove: 300_000, ...legacy.cost }] } };
		expect(fromCatalog(explicit).cost).toEqual(explicit.cost);
		const custom = { ...legacy, cost: { ...legacy.cost, input: 1 } };
		expect(fromCatalog(custom).cost).toEqual(custom.cost);
		const gateway = { ...legacy, provider: "opencode" };
		expect(fromCatalog(gateway).cost).toEqual(gateway.cost);
	});
});
