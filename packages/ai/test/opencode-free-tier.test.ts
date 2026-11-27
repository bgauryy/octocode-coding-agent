import { describe, expect, it } from "vitest";
import { OPENCODE_CLASSIFIER_MODELS, OPENCODE_MODELS } from "../src/providers/opencode.models.ts";
import { opencodeProvider } from "../src/providers/opencode.ts";

describe("OpenCode Zen provider", () => {
	const models = opencodeProvider().getModels();

	it("leaves out free-tier chat models, which OpenCode serves only to its own app", () => {
		const catalogFree = Object.values(OPENCODE_MODELS).filter(
			(model) => model.cost.input === 0 && model.cost.output === 0,
		);
		expect(catalogFree.length).toBeGreaterThan(0);
		const listed = new Set(models.map((model) => model.id));
		for (const model of catalogFree) expect(listed.has(model.id)).toBe(false);
	});

	it("keeps paid chat models and classifier models", () => {
		const paid = Object.values(OPENCODE_MODELS).filter((model) => model.cost.input > 0 || model.cost.output > 0);
		const listed = new Set(models.map((model) => model.id));
		for (const model of paid) expect(listed.has(model.id)).toBe(true);
		const all = new Set((opencodeProvider().getAllModels?.() ?? []).map((model) => model.id));
		for (const model of Object.values(OPENCODE_CLASSIFIER_MODELS)) expect(all.has(model.id)).toBe(true);
	});
});
