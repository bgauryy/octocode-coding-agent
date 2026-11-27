import { describe, expect, it } from "vitest";
import { processGoogleModels } from "../scripts/generate-models/processors.ts";
import { applyUpstreamCorrections } from "../scripts/generate-models/upstream-corrections.ts";
import type { ModelsDevModel } from "../scripts/generate-models/types.ts";
import { calculateCost } from "../src/models.ts";
import type { Api, Model, Usage } from "../src/types.ts";

const gemini = (id: string, cost: ModelsDevModel["cost"]): ModelsDevModel => ({
	id,
	name: id,
	tool_call: true,
	reasoning: true,
	limit: { context: 1_048_576, output: 65_536 },
	cost,
});

/** models.dev as fetched on 2026-11-01: the Gemini API image model lists no cache_read. */
const catalog = {
	google: {
		models: {
			"gemini-3.1-flash-lite-image": gemini("gemini-3.1-flash-lite-image", { input: 0.25, output: 30 }),
			"gemini-3.6-flash": gemini("gemini-3.6-flash", { input: 0.75, output: 3.75, cache_read: 0.075 }),
			"gemini-3.7-flash": gemini("gemini-3.7-flash", { input: 0.75, output: 3.75, cache_read: 0.075 }),
			"gemini-3.8-flash": gemini("gemini-3.8-flash", { input: 0.75, output: 3.75, cache_read: 0.075 }),
			"gemini-3.5-flash": gemini("gemini-3.5-flash", { input: 1.5, output: 9, cache_read: 0.15 }),
		},
	},
	"google-vertex": {
		models: {
			"gemini-3.1-flash-lite-image": gemini("gemini-3.1-flash-lite-image", {
				input: 0.25,
				output: 30,
				cache_read: 0.025,
			}),
			"gemini-3.6-flash": gemini("gemini-3.6-flash", { input: 0.75, output: 3.75, cache_read: 0.075 }),
		},
	},
};

function generate(): Model<Api>[] {
	const models = processGoogleModels(catalog);
	applyUpstreamCorrections(models);
	return models;
}

const find = (models: Model<Api>[], provider: string, id: string) => {
	const found = models.find((model) => model.provider === provider && model.id === id);
	if (!found) throw new Error(`missing ${provider}/${id}`);
	return found;
};

const million = (): Usage => ({
	input: 1_000_000,
	output: 1_000_000,
	cacheRead: 1_000_000,
	cacheWrite: 0,
	totalTokens: 3_000_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("Google generated pricing", () => {
	it("fills the official $0.025 cached-input rate the Gemini API catalog omits for the image model", () => {
		const models = generate();
		expect(find(models, "google", "gemini-3.1-flash-lite-image").cost).toMatchObject({
			input: 0.25,
			output: 30,
			cacheRead: 0.025,
		});
		expect(find(models, "google-vertex", "gemini-3.1-flash-lite-image").cost.cacheRead).toBe(0.025);
	});

	it("does not override a cached-input rate the catalog does list", () => {
		const models = processGoogleModels({
			google: {
				models: {
					"gemini-3.1-flash-lite-image": gemini("gemini-3.1-flash-lite-image", {
						input: 0.25,
						output: 30,
						cache_read: 0.04,
					}),
				},
			},
		});
		applyUpstreamCorrections(models);
		expect(models[0]?.cost.cacheRead).toBe(0.04);
	});

	it.each(["google", "google-vertex"])("%s Gemini 3.6 Flash steps up on 2027-01-01", (provider) => {
		const model = find(generate(), provider, "gemini-3.6-flash");
		expect(model.cost).toMatchObject({
			input: 0.75,
			output: 3.75,
			cacheRead: 0.075,
			until: "2026-12-31",
			after: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
		});
		const lastDay = calculateCost(model, million(), new Date("2026-12-31T23:59:59.999Z"));
		const firstDay = calculateCost(model, million(), new Date("2027-01-01T00:00:00Z"));
		expect(lastDay.total).toBeCloseTo(0.75 + 3.75 + 0.075, 10);
		expect(firstDay.total).toBeCloseTo(1.5 + 7.5 + 0.15, 10);
	});

	it("windows the Gemini 3.7 and 3.8 Flash intro prices the same way", () => {
		const models = generate();
		for (const id of ["gemini-3.7-flash", "gemini-3.8-flash"]) {
			expect(find(models, "google", id).cost).toMatchObject({
				until: "2026-12-31",
				after: { input: 1.5, output: 7.5, cacheRead: 0.15 },
			});
		}
	});

	it("leaves models with a single price, and intro windows whose upstream price changed, alone", () => {
		const models = generate();
		expect(find(models, "google", "gemini-3.5-flash").cost.until).toBeUndefined();

		const repriced = processGoogleModels({
			google: {
				models: { "gemini-3.6-flash": gemini("gemini-3.6-flash", { input: 1.5, output: 7.5, cache_read: 0.15 }) },
			},
		});
		applyUpstreamCorrections(repriced);
		expect(repriced[0]?.cost).toEqual({ input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 });
	});

	it("leaves other providers' Gemini 3.6 Flash prices alone", () => {
		const gateway: Model<Api> = {
			...find(generate(), "google", "gemini-3.6-flash"),
			provider: "opencode",
			cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
		};
		applyUpstreamCorrections([gateway]);
		expect(gateway.cost.until).toBeUndefined();
	});
});
