import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { editModelsProvider, removeModelsProvider } from "../src/core/provider-templates/models-file.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "octocode-official-guard-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const custom = {
	baseUrl: "https://bedrock-mantle.eu-central-1.api.aws/v1",
	api: "openai-completions",
	apiKey: "x",
	models: [{ id: "moonshotai.kimi-k3.1", contextWindow: 1000 }],
};

function write(file: string, providers: Record<string, unknown>): string {
	const path = join(dir, file);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify({ providers }));
	return path;
}

describe("models.json is for custom providers only", () => {
	test("an entry with an official id is refused with the file and id; the other providers still load", async () => {
		const path = write("models.json", { "amazon-bedrock": custom, "bedrock-mantle": custom });
		const config = await ModelConfig.loadFile(path);
		const error = config.getError() ?? "";
		expect(error).toContain(path);
		expect(error).toContain("providers.amazon-bedrock");
		expect(error).toMatch(/rename/);
		expect(error).toMatch(/\/providers/);
		expect(error).not.toContain("literal-secret");
		expect(config.getProviderIds()).toEqual(["bedrock-mantle"]);
		expect(config.isUnreadable()).toBe(false);
	});

	test("every official id is refused, whatever its fields", async () => {
		const path = write("models.json", { anthropic: { baseUrl: "https://proxy.example/v1" }, openai: { apiKey: "k" } });
		const config = await ModelConfig.loadFile(path);
		expect(config.getProviderIds()).toEqual([]);
		expect(config.getError()).toContain("providers.anthropic");
		expect(config.getError()).toContain("providers.openai");
	});

	test("per-model tuning of official models stays: modelOverrides with compat and limits only", async () => {
		const path = write("models.json", {
			"amazon-bedrock": {
				modelOverrides: {
					"anthropic.claude-fable-5": { compat: { supportsLongCacheRetention: false }, maxTokens: 4096 },
				},
			},
		});
		const config = await ModelConfig.loadFile(path);
		expect(config.getError()).toBeUndefined();
		expect(config.getProviderIds()).toEqual(["amazon-bedrock"]);
	});

	test("an override that would change host, api, key or headers is refused", async () => {
		const path = write("models.json", {
			"amazon-bedrock": { modelOverrides: { m: { baseUrl: "https://elsewhere.example", compat: {} } } },
		});
		const config = await ModelConfig.loadFile(path);
		expect(config.getProviderIds()).toEqual([]);
		expect(config.getError()).toContain("modelOverrides.m.baseUrl");
	});

	test("one refused field refuses the whole entry, its allowed overrides included, and the message says so", async () => {
		const path = write("models.json", {
			anthropic: { apiKey: "k", modelOverrides: { m: { cost: { input: 1 }, input: ["text", "image"] } } },
		});
		const config = await ModelConfig.loadFile(path);
		expect(config.getProviderIds()).toEqual([]);
		const error = config.getError() ?? "";
		expect(error).toContain("blocked: apiKey, modelOverrides.m.input");
		expect(error).toContain("its modelOverrides included");
		expect(error).toMatch(/keep only "modelOverrides" in this entry/);
	});

	test("Pi's models.json: the entry is skipped with a warning, there is no error and Pi's file is not changed", async () => {
		const piPath = write("pi/models.json", { "amazon-bedrock": custom, "pi-only": custom });
		const before = readFileSync(piPath, "utf8");
		const config = await ModelConfig.loadFile(piPath, { fallback: true });
		expect(config.getError()).toBeUndefined();
		expect(config.getProviderIds()).toEqual(["pi-only"]);
		expect(config.getWarnings().join("\n")).toContain("providers.amazon-bedrock");
		expect(readFileSync(piPath, "utf8")).toBe(before);
	});
});

describe("editing and removing a custom provider in models.json", () => {
	test("edit changes the host and one model's limits, keeping the rest of the file", async () => {
		const path = write("models.json", { mine: custom, other: custom });
		await editModelsProvider(path, "mine", {
			baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
			limits: { "moonshotai.kimi-k3.1": { contextWindow: 2000, maxTokens: 500 } },
		});
		const saved = JSON.parse(readFileSync(path, "utf8")).providers;
		expect(saved.mine.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/v1");
		expect(saved.mine.apiKey).toBe("x");
		expect(saved.mine.models[0]).toMatchObject({ contextWindow: 2000, maxTokens: 500 });
		expect(saved.other).toEqual(custom);
	});

	test("remove deletes one provider and keeps the others; an unknown id is an error", async () => {
		const path = write("models.json", { mine: custom, other: custom });
		await removeModelsProvider(path, "mine");
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).providers)).toEqual(["other"]);
		await expect(removeModelsProvider(path, "mine")).rejects.toThrow(/does not define/);
	});

	test("a file with comments is left alone and the error says what to change", async () => {
		const path = join(dir, "models.json");
		writeFileSync(path, `{\n// mine\n"providers": {"mine": ${JSON.stringify(custom)}}\n}`);
		await expect(removeModelsProvider(path, "mine")).rejects.toThrow(/has comments/);
		expect(readFileSync(path, "utf8")).toContain("// mine");
	});
});
