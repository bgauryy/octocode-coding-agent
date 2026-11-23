import type * as TypeboxCompile from "typebox/compile";
import { describe, expect, it, vi } from "vitest";

// Counts every TypeBox compile the modules below make. A module-level `Compile` ran at every start, whether or not
// the start read that kind of file: about 19 ms of the bundle's start for these six schemas (CPU profile, 2026-11-23).
const compiles = vi.hoisted(() => ({ count: 0 }));
vi.mock("typebox/compile", async (importOriginal) => {
	const actual = await importOriginal<typeof TypeboxCompile>();
	const Compile = ((...args: Parameters<typeof actual.Compile>) => {
		compiles.count++;
		return actual.Compile(...args);
	}) as typeof actual.Compile;
	return { ...actual, Compile, default: Compile };
});

describe("config file validators compile on first use", () => {
	it("loading the modules that validate models.json, models-store, keybindings, themes and skill snapshots compiles nothing", async () => {
		await Promise.all([
			import("../src/core/model-config.ts"),
			import("../src/core/provider-templates/models-file.ts"),
			import("../src/core/models-store-validation.ts"),
			import("../src/core/keybindings.ts"),
			import("../src/theme/theme-schema.ts"),
			import("../src/core/skill-resource-snapshot.ts"),
		]);
		expect(compiles.count).toBe(0);
	});

	it("compiles a schema once, on its first validation, and models.json's readers share it", async () => {
		const { modelsConfigValidator } = await import("../src/core/model-config.ts");
		const { isStoredModel } = await import("../src/core/models-store-validation.ts");
		const before = compiles.count;
		expect(modelsConfigValidator().Check({ providers: {} })).toBe(true);
		expect(modelsConfigValidator()).toBe(modelsConfigValidator());
		expect(compiles.count).toBe(before + 1);
		expect(isStoredModel({ id: "x" })).toBe(false);
		expect(isStoredModel({ id: "y" })).toBe(false);
		expect(compiles.count).toBe(before + 2);
	});
});
