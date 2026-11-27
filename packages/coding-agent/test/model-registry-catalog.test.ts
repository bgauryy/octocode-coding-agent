import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("ModelRegistry catalog update pass-throughs", () => {
	afterEach(() => vi.restoreAllMocks());

	it("answers getCatalogUpdate and isModelDeprecated from the runtime's catalog", async () => {
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runtime = getModelRuntime(registry);
		const old = { provider: "anthropic", id: "claude-sonnet-4-5" };
		const added = { provider: "anthropic", id: "claude-x" };
		vi.spyOn(runtime, "getCatalogUpdate").mockImplementation((model) =>
			model.id === old.id ? { deprecated: true } : model.id === added.id ? { source: "models.dev" } : undefined,
		);

		expect(registry.getCatalogUpdate(old)).toEqual({ deprecated: true });
		expect(registry.isModelDeprecated(old)).toBe(true);
		expect(registry.getCatalogUpdate(added)?.source).toBe("models.dev");
		expect(registry.isModelDeprecated(added)).toBe(false);
		expect(registry.getCatalogUpdate({ provider: "anthropic", id: "claude-opus-5-5" })).toBeUndefined();
	});
});
