import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { builtinProviders } from "@octocodeai/octocode-ai/providers/all";
import { configuredRequestsPerMinute, configuredTokensPerMinute } from "../src/core/model-runtime/request-rate.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { createSandbox, type Sandbox, write } from "./discovery/fixtures.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const own = () => join(sandbox.agentDir, "models.json");
const projectFile = () => join(sandbox.cwd, ".octocode", "models.json");
const json = (providers: Record<string, unknown>) => JSON.stringify({ providers });
const base = { baseUrl: "https://gw.example/v1", api: "openai-completions", apiKey: "global-key" };
const load = () => ModelConfig.load(own(), { cwd: sandbox.cwd, isTrusted: () => true });

async function models(provider: Record<string, unknown>, name = "gw") {
	write(own(), json({ [name]: { ...base, ...provider } }));
	const config = await load();
	return composeModelProvider(name, undefined, config, undefined).getModels();
}

describe("provider defaults", () => {
	it("apply to every model, and a model's own field wins", async () => {
		const list = await models({
			defaults: {
				contextWindow: 200000,
				maxTokens: 64000,
				input: ["text", "image"],
				thinkingLevelMap: { low: "a", high: "b" },
			},
			models: [{ id: "plain" }, { id: "own", maxTokens: 1000, thinkingLevelMap: { high: "c" } }],
		});
		const plain = list.find((model) => model.id === "plain");
		const own = list.find((model) => model.id === "own");
		expect(plain).toMatchObject({ contextWindow: 200000, maxTokens: 64000, input: ["text", "image"] });
		expect(own).toMatchObject({ contextWindow: 200000, maxTokens: 1000 });
		expect(own?.thinkingLevelMap).toMatchObject({ low: "a", high: "c" });
	});

	it("rank below modelOverrides", async () => {
		const list = await models({
			defaults: { contextWindow: 200000 },
			models: [{ id: "a" }, { id: "b" }],
			modelOverrides: { b: { contextWindow: 5000 } },
		});
		expect(list.find((model) => model.id === "a")?.contextWindow).toBe(200000);
		expect(list.find((model) => model.id === "b")?.contextWindow).toBe(5000);
	});
});

describe("scope merge", () => {
	it("merges global and project field by field", async () => {
		write(
			own(),
			json({ gw: { ...base, defaults: { contextWindow: 100000, maxTokens: 8000 }, models: [{ id: "g" }] } }),
		);
		write(projectFile(), json({ gw: { defaults: { maxTokens: 4000 }, models: [{ id: "p" }], tokensPerMinute: 9 } }));
		const config = await load();
		const provider = config.getProvider("gw");
		expect(provider?.baseUrl).toBe(base.baseUrl);
		expect(provider?.defaults).toEqual({ contextWindow: 100000, maxTokens: 4000 });
		expect(provider?.models?.map((model) => model.id)).toEqual(["g", "p"]);
		expect(provider?.tokensPerMinute).toBe(9);
		expect(config.getError()).toBeUndefined();
	});

	it("refuses a project's baseUrl, api, headers and apiKey for a global provider, with a warning", async () => {
		write(own(), json({ gw: { ...base, models: [{ id: "g" }] } }));
		write(
			projectFile(),
			json({
				gw: {
					baseUrl: "https://evil.example/v1",
					api: "anthropic-messages",
					headers: { "x-a": "b" },
					apiKey: "stolen",
					models: [{ id: "p", baseUrl: "https://evil.example/v2" }],
					defaults: { maxTokens: 1 },
				},
			}),
		);
		const config = await load();
		const provider = config.getProvider("gw");
		expect(provider).toMatchObject({ baseUrl: base.baseUrl, api: base.api, apiKey: "global-key" });
		expect(provider?.headers).toBeUndefined();
		expect(provider?.models?.find((model) => model.id === "p")?.baseUrl).toBeUndefined();
		expect(provider?.defaults?.maxTokens).toBe(1);
		const warning = config.getWarnings().find((text) => text.includes("which a global models.json also defines")) ?? "";
		for (const field of ["baseUrl", "api", "headers", "apiKey", "models[p].baseUrl"]) expect(warning).toContain(field);
		expect(warning).not.toContain("stolen");
	});

	it("refuses a project's auth and env for a global provider, and keeps its global key source", async () => {
		write(own(), json({ gw: { ...base, env: ["GW_KEY"], models: [{ id: "g" }] } }));
		write(projectFile(), json({ gw: { auth: { command: "steal" }, env: ["OTHER"], models: [{ id: "p" }] } }));
		const config = await load();
		const provider = config.getProvider("gw");
		expect(provider?.auth).toBeUndefined();
		expect(provider?.env).toEqual(["GW_KEY"]);
		const warning = config.getWarnings().find((text) => text.includes("also defines")) ?? "";
		expect(warning).toContain("auth");
		expect(warning).toContain("env");
		expect(warning).not.toContain("steal");
	});

	it.each(["baseUrl", "api", "headers", "apiKey", "auth", "env"])(
		"refuses a project's %s on a built-in provider, which holds a key from elsewhere",
		async (field) => {
			const values: Record<string, unknown> = {
				baseUrl: "https://evil.example/v1",
				api: "openai-responses",
				headers: { a: "b" },
				apiKey: "k",
				auth: { command: "steal" },
				env: ["X"],
			};
			write(projectFile(), json({ anthropic: { [field]: values[field] } }));
			const config = await load();
			expect(config.getProvider("anthropic")).toBeUndefined();
			expect(config.getError()).toContain(`blocked: ${field}`);
		},
	);

	it("lets a project-only provider set its own baseUrl", async () => {
		write(own(), json({ other: { ...base, models: [{ id: "g" }] } }));
		write(projectFile(), json({ mine: { ...base, baseUrl: "https://mine.example/v1", models: [{ id: "p" }] } }));
		const config = await load();
		expect(config.getProvider("mine")?.baseUrl).toBe("https://mine.example/v1");
		expect(config.getWarnings().some((text) => text.includes("also defines"))).toBe(false);
	});

	it("loads a plain Pi models.json as it is", async () => {
		const pi = { ...base, models: [{ id: "m", contextWindow: 1234 }], modelOverrides: { m: { maxTokens: 5 } } };
		write(join(sandbox.piAgentDir, "models.json"), json({ piGw: pi }));
		const config = await load();
		expect(config.getProvider("piGw")).toEqual(pi);
		expect(config.getWarnings()).toEqual([]);
		const list = composeModelProvider("piGw", undefined, config, undefined).getModels();
		expect(list[0]).toMatchObject({ id: "m", contextWindow: 1234, maxTokens: 5 });
	});
});

describe("official providers", () => {
	it("take a throttle and tuning defaults, and still refuse where requests go", async () => {
		write(
			own(),
			json({
				anthropic: {
					requestsPerMinute: 3,
					tokensPerMinute: 1000,
					defaults: { contextWindow: 12345 },
					modelOverrides: { "claude-x": { requestsPerMinute: 1 } },
				},
			}),
		);
		const config = await load();
		expect(config.getError()).toBeUndefined();
		const provider = config.getProvider("anthropic");
		expect(configuredRequestsPerMinute(provider, "any")).toBe(3);
		expect(configuredRequestsPerMinute(provider, "claude-x")).toBe(1);
		expect(configuredTokensPerMinute(provider, "any")).toBe(1000);
		const base = builtinProviders().find((provider) => provider.id === "anthropic");
		const composed = composeModelProvider("anthropic", base, config, undefined).getModels();
		expect(composed.length).toBeGreaterThan(0);
		expect(composed.every((model) => model.contextWindow === 12345)).toBe(true);
	});

	it.each([
		["defaults", { baseUrl: "https://evil.example/v1" }, "defaults.baseUrl"],
		["defaults", { headers: { a: "b" } }, "defaults.headers"],
		["models", [{ id: "m" }], "models"],
	])("refuses %s carrying a forbidden field", async (field, value, blocked) => {
		write(own(), json({ anthropic: { [field]: value } }));
		const config = await load();
		expect(config.getProvider("anthropic")).toBeUndefined();
		expect(config.getError()).toContain(blocked);
	});
});
