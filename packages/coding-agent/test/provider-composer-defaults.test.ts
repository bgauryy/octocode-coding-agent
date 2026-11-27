import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { defaultedModelNotice } from "../src/core/provider-composer/models.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function compose(provider: Record<string, unknown>, name: string) {
	const dir = mkdtempSync(join(tmpdir(), "octocode-composer-defaults-"));
	dirs.push(dir);
	const path = join(dir, "models.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: { [name]: { baseUrl: "http://localhost:1/v1", api: "openai-completions", apiKey: "k", ...provider } },
		}),
	);
	return composeModelProvider(name, undefined, await ModelConfig.load(path), undefined);
}

describe("custom models with defaulted fields", () => {
	it("names every defaulted field in one notice, with the assumed window and how to set it", async () => {
		const provider = await compose({ models: [{ id: "local" }] }, "defaults-a");
		expect(provider.getModels()[0]?.contextWindow).toBe(128000);
		const notice = defaultedModelNotice("defaults-a", "local") ?? "";
		for (const word of ["cost", "input", "contextWindow", "128000", "maxTokens", "16384"])
			expect(notice).toContain(word);
	});

	it("names only what the entry left out", async () => {
		await compose({ models: [{ id: "local", contextWindow: 32000, maxTokens: 4096, input: ["text"] }] }, "defaults-b");
		const notice = defaultedModelNotice("defaults-b", "local") ?? "";
		expect(notice).toContain("cost");
		expect(notice).not.toContain("contextWindow");
	});

	it("says nothing for a model that sets every field, or whose override sets the window", async () => {
		await compose(
			{
				models: [
					{
						id: "full",
						contextWindow: 32000,
						maxTokens: 4096,
						input: ["text"],
						cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
			"defaults-c",
		);
		expect(defaultedModelNotice("defaults-c", "full")).toBeUndefined();
		await compose({ models: [{ id: "local" }], modelOverrides: { local: { contextWindow: 32000 } } }, "defaults-d");
		expect(defaultedModelNotice("defaults-d", "local")).not.toContain("contextWindow");
	});
});
