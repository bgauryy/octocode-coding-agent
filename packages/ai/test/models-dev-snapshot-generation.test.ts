import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatedAt, providers } from "@opencode-ai/models/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import {
	createModelDataManifest,
	MODEL_DATA_MANIFEST_FILE,
	readModelsDevStamp,
	validateModelDataDirectory,
} from "../scripts/model-data.ts";
import { mergeModelsDevSources, modelsDevSources } from "../scripts/generate-models/models-dev-sources.ts";
import { readModelsDevManifestSource } from "../src/catalog/models-dev-sources.ts";
import { type BuiltinProvider, getBuiltinModels, getBuiltinProviders } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "octocode-models-dev-snapshot-"));
	roots.push(root);
	return root;
}

describe("generator models.dev source", () => {
	it("builds a models.dev provider from the pinned snapshot with every request refused", () => {
		const root = temporaryRoot();
		const preload = join(root, "no-network.mjs");
		writeFileSync(preload, `globalThis.fetch = async (input) => { throw new Error("network blocked: " + input); };\n`);
		const output = join(root, "catalog");
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preload).href,
				"scripts/generate-models.ts",
				"--providers",
				"anthropic",
				"--json-only",
				"--json-output",
				output,
			],
			{ cwd: packageRoot, encoding: "utf8", timeout: 60_000 },
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain(
			`Reading the models.dev snapshot of @opencode-ai/models (generated ${generatedAt})`,
		);
		const anthropic = JSON.parse(readFileSync(join(output, "providers/anthropic.json"), "utf8")) as Record<
			string,
			Model<"anthropic-messages">
		>;
		const listed = Object.entries(providers.anthropic?.models ?? {}).filter(
			([, model]) => model.tool_call && !model.type,
		);
		expect(listed.length).toBeGreaterThan(0);
		for (const [id, model] of listed) {
			expect(anthropic[id]?.api).toBe("anthropic-messages");
			expect(anthropic[id]?.contextWindow).toBe(model.limit.context);
		}
	});
});

describe("models.dev stamp in the data manifest", () => {
	const structure = { anthropic: { "chat:claude-a": "anthropic-messages" } };
	const content = `${JSON.stringify({
		"anthropic-messages": {
			"chat:claude-a": {
				type: "chat",
				id: "claude-a",
				name: "Claude A",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			},
		},
	})}\n`;

	function writeData(manifest: object): string {
		const dataDir = join(temporaryRoot(), "data");
		mkdirSync(dataDir);
		writeFileSync(join(dataDir, "anthropic.json"), content);
		writeFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), JSON.stringify(manifest));
		return dataDir;
	}

	// The stamp records each provider's listing and left-out ids (`modelsDevSources`), replacing the bare provider list,
	// which could not say which listing a provider reads or which ids it must never gain at runtime.
	const sources = {
		zai: { listing: "zai-coding-plan", prices: "zai", excluded: ["glm-b", "glm-a"] },
		openai: { listing: "openai", excluded: ["gpt-5.6"] },
	};

	it("records when the models.dev data was taken and each provider's listing and left-out ids", () => {
		const stamp = { generatedAt: "2026-11-22T05:24:37.726Z", sources };
		const manifest = createModelDataManifest(structure, { "anthropic.json": content }, "2026-11-23T00:00:00Z", stamp);
		expect(manifest).toMatchObject({
			modelsDevGeneratedAt: stamp.generatedAt,
			modelsDevSources: {
				openai: { listing: "openai", excluded: ["gpt-5.6"] },
				zai: { listing: "zai-coding-plan", prices: "zai", excluded: ["glm-a", "glm-b"] },
			},
		});
		expect(Object.keys(manifest.modelsDevSources ?? {})).toEqual(["openai", "zai"]);
		const dataDir = writeData(manifest);
		expect(() => validateModelDataDirectory(structure, dataDir)).not.toThrow();
		expect(readModelsDevStamp(dataDir)).toEqual({ generatedAt: stamp.generatedAt, sources: manifest.modelsDevSources });
		expect(readModelsDevManifestSource(manifest as unknown as Record<string, unknown>)).toEqual({
			generatedAt: Date.parse(stamp.generatedAt),
			sources: manifest.modelsDevSources,
		});
	});

	it("accepts a manifest without the stamp, or with the retired provider list, and rejects a malformed one", () => {
		const plain = createModelDataManifest(structure, { "anthropic.json": content }, "2026-11-23T00:00:00Z");
		expect(plain).not.toHaveProperty("modelsDevSources");
		expect(readModelsDevStamp(writeData(plain))).toBeUndefined();
		expect(readModelsDevManifestSource(plain as unknown as Record<string, unknown>)).toBeUndefined();
		// Hydrated before sources were recorded: valid, and the runtime adds and reprices nothing (never a guess).
		const retired = { ...plain, modelsDevGeneratedAt: "2026-11-22T05:24:37.726Z", modelsDevOwners: ["openai"] };
		expect(() => validateModelDataDirectory(structure, writeData(retired))).not.toThrow();
		expect(readModelsDevManifestSource(retired)).toBeUndefined();
		const malformed = writeData({
			...plain,
			modelsDevGeneratedAt: "soon",
			modelsDevSources: { openai: { listing: "openai", excluded: [1] } },
		});
		expect(() => validateModelDataDirectory(structure, malformed)).toThrow(
			/invalid models\.dev timestamp[\s\S]*invalid models\.dev sources/,
		);
		expect(readModelsDevStamp(malformed)).toBeUndefined();
	});
});

describe("models.dev sources of the built-in providers", () => {
	const standard = Object.fromEntries(
		Object.entries(providers).map(([id, provider]) => [
			id,
			{ models: Object.fromEntries(Object.entries(provider.models ?? {}).filter(([, model]) => !model.type)) },
		]),
	);
	const bundledIds = (provider: string) => getBuiltinModels(provider as BuiltinProvider).map((model) => model.id);
	const built = modelsDevSources(standard, bundledIds, getBuiltinProviders());

	it("names the listing each provider is built from, Z.ai's coding plans priced from the pay-as-you-go list", () => {
		expect(built.zai).toMatchObject({ listing: "zai-coding-plan", prices: "zai" });
		expect(built["zai-coding-cn"]).toMatchObject({ listing: "zhipuai-coding-plan", prices: "zai" });
		expect(built.fireworks?.listing).toBe("fireworks-ai");
		expect(built["kimi-coding"]?.listing).toBe("kimi-code-plan-global");
		expect(built.anthropic).toMatchObject({ listing: "anthropic" });
		// Rewritten ids, a live id list, a fixed subset, and providers not built from models.dev: no runtime additions.
		for (const provider of ["cloudflare-ai-gateway", "nvidia", "qwen-token-plan-individual", "openrouter", "azure"])
			expect(built[provider]).toBeUndefined();
	});

	it("leaves out the ids the generator excludes, listed or not yet listed", () => {
		expect(built.openai?.excluded).toContain("gpt-5.6");
		expect(built.xai?.excluded).toEqual(expect.arrayContaining(["grok-4.20-0309-reasoning", "grok-build-0.1"]));
		expect(built["amazon-bedrock"]?.excluded).toContain("anthropic.claude-opus-5");
		expect(built.opencode?.excluded).toContain("gpt-5.3-codex-spark");
		for (const [provider, source] of Object.entries(built)) {
			const bundled = new Set(bundledIds(provider));
			expect(
				source.excluded.filter((id) => bundled.has(id)),
				provider,
			).toEqual([]);
		}
	});

	it("keeps the recorded sources of providers a scoped run did not rebuild", () => {
		const previous = { openai: { listing: "openai", excluded: ["old"] }, xai: { listing: "xai", excluded: [] } };
		const next = { openai: { listing: "openai", excluded: ["gpt-5.6"] } };
		expect(mergeModelsDevSources(previous, next, ["openai", "anthropic"])).toEqual({
			openai: { listing: "openai", excluded: ["gpt-5.6"] },
			xai: { listing: "xai", excluded: [] },
		});
	});
});
