import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("strict model generation", () => {
	it.each([
		["an empty list", { data: [] }],
		["a malformed list", { data: {} }],
		["an unexpected success body", { message: "unavailable" }],
	])("preserves the output when a selected provider returns %s", (_scenario, body) => {
		const root = mkdtempSync(join(tmpdir(), "octocode-partial-catalog-"));
		temporaryRoots.push(root);
		const preload = join(root, "gateway.mjs");
		const output = join(root, "catalog");
		mkdirSync(output);
		const previous = join(output, "models.json");
		writeFileSync(previous, "previous complete catalog");
		writeFileSync(
			preload,
			`globalThis.fetch = async (input) => {
			if (String(input) !== "https://ai-gateway.vercel.sh/v1/models") throw new Error("Unexpected fetch: " + input);
			return Response.json(${JSON.stringify(body)});
		};`,
		);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preload).href,
				"scripts/generate-models.ts",
				"--providers",
				"vercel-ai-gateway",
				"--json-only",
				"--json-output",
				output,
			],
			{ cwd: packageRoot, encoding: "utf8", timeout: 10_000 },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Vercel AI Gateway returned no catalog rows");
		expect(readFileSync(previous, "utf8")).toBe("previous complete catalog");
	});

	it("fails when a missing provider feed would otherwise leave only its manual fallback", () => {
		const root = mkdtempSync(join(tmpdir(), "octocode-missing-source-"));
		temporaryRoots.push(root);
		const preload = join(root, "source.mjs");
		const output = join(root, "catalog");
		mkdirSync(output);
		writeFileSync(join(output, "models.json"), "previous catalog");
		writeFileSync(
			preload,
			`globalThis.fetch = async (url) => {
			if (String(url) !== "https://models.dev/api.json") throw new Error("Unexpected fetch: " + url);
			return Response.json({});
		};`,
		);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preload).href,
				"scripts/generate-models.ts",
				"--live",
				"--providers",
				"mistral",
				"--json-only",
				"--json-output",
				output,
			],
			{ cwd: packageRoot, encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("models.dev returned no usable chat models for: mistral");
		expect(readFileSync(join(output, "models.json"), "utf8")).toBe("previous catalog");
	});

	it("preserves the previous JSON export when writing a provider shard fails", () => {
		const root = mkdtempSync(join(tmpdir(), "octocode-failed-export-"));
		temporaryRoots.push(root);
		const output = join(root, "catalog");
		mkdirSync(output);
		writeFileSync(join(output, "models.json"), "previous catalog");
		const preload = join(root, "write-failure.mjs");
		writeFileSync(
			preload,
			`
			import fs from "node:fs";
			import {syncBuiltinESMExports} from "node:module";
			const write = fs.writeFileSync;
			fs.writeFileSync = function(file, ...args) {
				if (String(file).endsWith("/ant-ling.all.json")) throw new Error("injected write error");
				return write(file, ...args);
			};
			syncBuiltinESMExports();
			globalThis.fetch = async () => {throw new Error("unexpected fetch for a manual catalog")};
		`,
		);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preload).href,
				"scripts/generate-models.ts",
				"--providers",
				"ant-ling",
				"--json-only",
				"--json-output",
				output,
			],
			{ cwd: packageRoot, encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("injected write error");
		expect(readFileSync(join(output, "models.json"), "utf8")).toBe("previous catalog");
	});

	it("refuses to publish a catalog with a missing official provider", () => {
		const root = mkdtempSync(join(tmpdir(), "octocode-incomplete-providers-"));
		temporaryRoots.push(root);
		const entry = join(root, "export.mjs");
		const output = join(root, "catalog");
		mkdirSync(output);
		writeFileSync(join(output, "models.json"), "previous catalog");
		writeFileSync(
			entry,
			`
			import {writeModelCatalogs} from ${JSON.stringify(pathToFileURL(join(packageRoot, "scripts/generate-models/writers.ts")).href)};
			writeModelCatalogs({ sortedProviderIds: [], jsonChatProviders: {}, jsonAllProviders: {} });
		`,
		);
		const result = spawnSync(process.execPath, [entry, "--json-only", "--json-output", output], { encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/missing registered providers: .*cerebras/);
		expect(readFileSync(join(output, "models.json"), "utf8")).toBe("previous catalog");
	});

	it("fails before mutating generated data when an Individual model loses tool support", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "octocode-generate-models-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		// Workspace dependencies (such as @octocodeai/octocode-contracts) resolve from the repository; only ai is copied.
		symlinkSync(join(packageRoot, "..", "..", "node_modules"), join(fixtureRoot, "node_modules"), "junction");
		const preloadPath = join(fixtureRoot, "mock-models-dev.mjs");
		const modelIds = [
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"deepseek-v4-pro-0813",
			"glm-5.2",
			"qwen3.6-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-flash",
			"qwen3.8-max",
			"qwen3.8-max-preview",
		];
		const sourceModels = Object.fromEntries(
			modelIds.map((id) => [
				id,
				{
					id,
					name: id,
					tool_call: id !== "deepseek-v4-flash-0731",
				},
			]),
		);
		const catalog = { "alibaba-token-plan": { models: sourceModels } };
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  if (String(input) === "https://models.dev/api.json") {\n` +
				`    return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  }\n` +
				`  throw new Error(\`Unexpected fetch: \${String(input)}\`);\n` +
				`};\n`,
		);

		const generatedPaths = [
			"src/models.generated.ts",
			"src/providers/qwen-token-plan-individual.models.ts",
			"src/providers/data/qwen-token-plan-individual.json",
			"src/providers/data/.manifest.json",
		];
		const sourceBefore = generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"));
		const isolatedBefore = generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"));

		const result = spawnSync(
			process.execPath,
			[
				"--conditions=source",
				"--import",
				pathToFileURL(preloadPath).href,
				"scripts/generate-models.ts",
				"--strict",
				"--live",
			],
			{
				cwd: isolatedPackageRoot,
				encoding: "utf8",
				timeout: 10_000,
			},
		);

		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			"qwen-token-plan-individual model IDs do not match (missing: deepseek-v4-flash-0731)",
		);
		expect(generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"))).toEqual(isolatedBefore);
		expect(generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"))).toEqual(sourceBefore);
	});
});
