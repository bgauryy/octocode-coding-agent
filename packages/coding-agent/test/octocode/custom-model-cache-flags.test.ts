import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createModelRegistry } from "../model-runtime-test-utils.ts";

describe("custom models resolve cache capabilities from data", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "octocode-custom-cache-flags-"));
		mkdirSync(dir, { recursive: true });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	async function resolve(model: Record<string, unknown>, providerCompat?: Record<string, unknown>) {
		const modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"corp-openai": {
						baseUrl: "https://api.openai.com/v1",
						apiKey: "test-key",
						api: "openai-responses",
						...(providerCompat ? { compat: providerCompat } : {}),
						models: [{ id: "gpt-5.5-2031-01-01", contextWindow: 100000, maxTokens: 8000, ...model }],
					},
				},
			}),
		);
		const registry = await createModelRegistry(AuthStorage.inMemory(), modelsPath);
		const found = registry.find("corp-openai", "gpt-5.5-2031-01-01");
		expect(found).toBeDefined();
		return found?.compat as Record<string, unknown> | undefined;
	}

	test("an extended-retention id on api.openai.com gets long retention", async () => {
		expect((await resolve({}))?.supportsLongCacheRetention).toBe(true);
	});

	test("an explicit model compat value wins", async () => {
		expect((await resolve({ compat: { supportsLongCacheRetention: false } }))?.supportsLongCacheRetention).toBe(false);
	});

	test("an explicit provider compat value wins", async () => {
		expect((await resolve({}, { supportsLongCacheRetention: false }))?.supportsLongCacheRetention).toBe(false);
	});
});
