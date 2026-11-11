import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "@octocodeai/octocode-ai";
import { getBuiltinModels, getBuiltinProviders } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getModelsPath } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { vendorChatModels } from "../src/core/provider-composer/known-models.ts";
import { NO_KEY } from "../src/core/models-json-keys.ts";
import { addTemplateProvider, freeProviderId, templateProviderEntry } from "../src/core/provider-templates/apply.ts";
import {
	type ListedModel,
	type TemplateModelSources,
	templateModelEntries,
	templateModels,
} from "../src/core/provider-templates/models.ts";
import { PROVIDER_TEMPLATES, type ProviderTemplate } from "../src/core/provider-templates/templates.ts";
import { showProviderTemplates } from "../src/modes/interactive/interactive-mode/provider-template.ts";
import { createSandbox, type Sandbox, write } from "./discovery/fixtures.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

const template = (id: string): ProviderTemplate => {
	const found = PROVIDER_TEMPLATES.find((entry) => entry.id === id);
	if (!found) throw new Error(`no template ${id}`);
	return found;
};

/** The built-in providers, as the runtime would give them to `vendorChatModels`. */
const builtins = {
	get: (id: string) =>
		(getBuiltinProviders() as string[]).includes(id)
			? ({ id, getModels: () => getBuiltinModels(id as never) } as unknown as Provider)
			: undefined,
};

const NEBIUS_LISTING: ListedModel[] = [
	{
		id: "openai/gpt-oss-120b",
		context: 131072,
		reasoning: true,
		toolCall: true,
		input: ["text"],
		cost: { input: 0.15, output: 0.6 },
	},
	{ id: "google/gemma-3-27b-it", context: 110000, toolCall: true, input: ["text", "image", "pdf"] },
	{ id: "old/model", status: "deprecated", toolCall: true },
	{ id: "embed/model", toolCall: false },
];
const sources: TemplateModelSources = {
	vendorModels: (api) => vendorChatModels(builtins, api),
	listed: (catalog) => (catalog === "nebius" ? NEBIUS_LISTING : []),
};

describe("provider template catalog", () => {
	test("every template is complete and none duplicates a built-in provider", () => {
		const ids = PROVIDER_TEMPLATES.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		const builtIn = new Set<string>(getBuiltinProviders());
		for (const entry of PROVIDER_TEMPLATES) {
			expect(builtIn.has(entry.id), entry.id).toBe(false);
			expect(entry.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
			expect(entry.docs).toMatch(/^https:\/\//);
			expect(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]).toContain(
				entry.api,
			);
			// A fixed host is HTTPS; without one the user gives the host and is shown an example.
			if (entry.baseUrl) expect(entry.baseUrl).toMatch(/^https:\/\/[^/]+/);
			else expect(entry.hostHint).toMatch(/^https?:\/\//);
			if (entry.keyEnv) expect(entry.keyEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
			expect(entry.key === "optional").toBe(entry.kind === "local");
			if (entry.kind === "hosted") expect(entry.baseUrl).toBeDefined();
			if (entry.kind === "gateway") expect(entry.baseUrl).toBeUndefined();
		}
		for (const api of ["anthropic-messages", "openai-responses", "google-generative-ai"]) {
			expect(PROVIDER_TEMPLATES.some((entry) => entry.kind === "gateway" && entry.api === api)).toBe(true);
		}
		for (const local of ["ollama", "lmstudio", "vllm"]) expect(template(local).kind).toBe("local");
	});

	test("a gateway offers the vendor's models; a hosted service its usable catalog listing", () => {
		const anthropic = templateModels(template("anthropic-gateway"), sources);
		expect(anthropic.map((model) => model.id)).toContain("claude-opus-5-5");
		expect(anthropic.every((model) => model.source === "vendor")).toBe(true);
		expect(templateModels(template("nebius"), sources).map((model) => model.id)).toEqual([
			"google/gemma-3-27b-it",
			"openai/gpt-oss-120b",
		]);
		expect(templateModels(template("hyperbolic"), sources)).toEqual([]);
	});
});

describe("applying a template", () => {
	let sandbox: Sandbox;
	let file: string;
	beforeEach(() => {
		sandbox = createSandbox();
		file = getModelsPath();
		if (!file.startsWith(sandbox.home)) throw new Error("models.json is outside the sandbox home");
	});
	afterEach(() => sandbox.cleanup());

	const nebius = (key: Parameters<typeof templateProviderEntry>[1]["key"]) =>
		templateProviderEntry(template("nebius"), {
			key,
			models: templateModelEntries(template("nebius"), ["openai/gpt-oss-120b", "typed/model"], sources),
		});

	test("adds the provider to a new private models.json", async () => {
		await addTemplateProvider(file, "nebius", nebius({ kind: "env", name: "NEBIUS_API_KEY" }));
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const saved = JSON.parse(readFileSync(file, "utf8"));
		expect(saved.providers.nebius).toEqual({
			name: "Nebius Token Factory",
			baseUrl: "https://api.tokenfactory.nebius.com/v1",
			api: "openai-completions",
			apiKey: "$NEBIUS_API_KEY",
			compat: { maxTokensField: "max_tokens", supportsStore: false, supportsDeveloperRole: false },
			models: [
				{
					id: "openai/gpt-oss-120b",
					contextWindow: 131072,
					reasoning: true,
					input: ["text"],
					cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
				},
				{ id: "typed/model" },
			],
		});
	});

	test("keeps the rest of the file and refuses an id it already defines", async () => {
		const existing = {
			$schema: "./schema.json",
			providers: { mine: { baseUrl: "http://localhost:1/v1", api: "openai-completions", apiKey: "x", models: [] } },
		};
		write(file, JSON.stringify(existing));
		await addTemplateProvider(file, "nebius", nebius({ kind: "saved" }));
		const after = JSON.parse(readFileSync(file, "utf8"));
		expect(after.$schema).toBe("./schema.json");
		expect(after.providers.mine).toEqual(existing.providers.mine);
		expect(Object.keys(after.providers)).toEqual(["mine", "nebius"]);

		const before = readFileSync(file, "utf8");
		await expect(addTemplateProvider(file, "mine", nebius({ kind: "saved" }))).rejects.toThrow(/already defines/);
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(freeProviderId("nebius", new Set(["nebius", "nebius-2"]))).toBe("nebius-3");
	});

	test("leaves a file with comments alone and hands back the entry", async () => {
		write(file, '{\n\t// mine\n\t"providers": {}\n}\n');
		await expect(addTemplateProvider(file, "nebius", nebius({ kind: "saved" }))).rejects.toThrow(/has comments/);
		expect(readFileSync(file, "utf8")).toContain("// mine");
	});

	test("never writes a key: a saved key goes to auth.json, others are a reference or the local marker", () => {
		expect(nebius({ kind: "saved" }).apiKey).toBeUndefined();
		expect(nebius({ kind: "env", name: "NEBIUS_API_KEY" }).apiKey).toBe("$NEBIUS_API_KEY");
		expect(() => nebius({ kind: "env", name: "sk-live key" })).toThrow(/environment variable/);
		expect(() => nebius({ kind: "none" })).toThrow(/needs an API key/);
		const ollama = templateProviderEntry(template("ollama"), { key: { kind: "none" }, models: [{ id: "qwen3:8b" }] });
		expect(ollama).toMatchObject({ baseUrl: "http://localhost:11434/v1", apiKey: NO_KEY });
		expect(() =>
			templateProviderEntry(template("openai-gateway"), {
				host: "https://user:secret@gw.example.com/v1",
				key: { kind: "saved" },
				models: [{ id: "gpt-6.1-sol" }],
			}),
		).toThrow(/must not carry a key/);
		expect(() =>
			templateProviderEntry(template("openai-gateway"), { key: { kind: "saved" }, models: [{ id: "x" }] }),
		).toThrow(/needs the host/);
	});

	test("a gateway template's vendor ids load with the vendor's metadata; catalog ids with the listing's", async () => {
		const gateway = template("anthropic-gateway");
		await addTemplateProvider(
			file,
			"anthropic-gateway",
			templateProviderEntry(gateway, {
				host: "https://gw.example.com/anthropic/",
				key: { kind: "env", name: "GW_KEY" },
				models: templateModelEntries(gateway, ["claude-opus-5-5"], sources),
			}),
		);
		await addTemplateProvider(file, "nebius", nebius({ kind: "env", name: "NEBIUS_API_KEY" }));
		const registry = await createModelRegistry(AuthStorage.inMemory(), file);
		expect(registry.getError()).toBeUndefined();

		const known = (getBuiltinModels("anthropic") as { id: string }[]).find((m) => m.id === "claude-opus-5-5") as never;
		const model = registry.find("anthropic-gateway", "claude-opus-5-5")!;
		expect(model).toMatchObject({
			baseUrl: "https://gw.example.com/anthropic",
			api: "anthropic-messages",
			contextWindow: (known as { contextWindow: number }).contextWindow,
			maxTokens: (known as { maxTokens: number }).maxTokens,
			reasoning: (known as { reasoning: boolean }).reasoning,
			input: (known as { input: string[] }).input,
			cost: (known as { cost: unknown }).cost,
		});
		// Direct-host cache claims do not carry to the gateway.
		expect(model.promptCache).toBeUndefined();

		expect(registry.find("nebius", "openai/gpt-oss-120b")).toMatchObject({
			contextWindow: 131072,
			reasoning: true,
			cost: { input: 0.15, output: 0.6 },
			compat: { maxTokensField: "max_tokens", supportsStore: false },
		});
	});
});

describe("/providers → Add from a template", () => {
	let sandbox: Sandbox;
	beforeEach(() => {
		sandbox = createSandbox();
	});
	afterEach(() => sandbox.cleanup());

	test("writes the entry under a free id, refreshes models and opens the provider's API-key sign-in", async () => {
		const label = (id: string) => `${template(id).name} — `;
		const host = {
			session: {
				modelRuntime: {
					getBuiltinProvider: () => undefined,
					getProviders: () => [{ id: "hyperbolic" }],
					getProvider: (id: string) => (id === "hyperbolic-2" ? { id, name: "Hyperbolic" } : undefined),
					getConfigurationDirectory: () => sandbox.agentDir,
					refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
				},
			},
			showExtensionSelector: vi.fn(async (_title: string, options: string[]) =>
				options.find((option) => option.startsWith(label("hyperbolic")) || option.startsWith("Save a key")),
			),
			showExtensionInput: vi.fn(async () => "moonshotai/Kimi-K2-Instruct, Qwen/Qwen3-Coder-480B-A35B-Instruct"),
			showApiKeyLoginDialog: vi.fn(async () => {}),
			updateAvailableProviderCount: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};
		const ctx = { host: createFakeHost(host), reopen: vi.fn() };
		expect(await showProviderTemplates(ctx.host, ctx.reopen, [])).toBe(true);
		expect(host.showError).not.toHaveBeenCalled();
		const saved = JSON.parse(readFileSync(join(sandbox.agentDir, "models.json"), "utf8"));
		expect(saved.providers["hyperbolic-2"]).toMatchObject({
			baseUrl: "https://api.hyperbolic.ai/inference/v1",
			models: [{ id: "moonshotai/Kimi-K2-Instruct" }, { id: "Qwen/Qwen3-Coder-480B-A35B-Instruct" }],
		});
		expect(saved.providers["hyperbolic-2"].apiKey).toBeUndefined();
		expect(host.session.modelRuntime.refresh).toHaveBeenCalledWith({ allowNetwork: false });
		expect(host.showApiKeyLoginDialog).toHaveBeenCalledWith("hyperbolic-2", "Hyperbolic", expect.any(Function));
	});

	test("a gateway takes the host the user gives and a key variable the user names", async () => {
		const answers = ["https://llm.corp.example/openai/v1/", "gpt-6.1-sol", "$CORP_LLM_KEY"];
		const host = {
			session: {
				modelRuntime: {
					getBuiltinProvider: () => undefined,
					getProviders: () => [],
					getProvider: () => undefined,
					getConfigurationDirectory: () => sandbox.agentDir,
					refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
				},
			},
			showExtensionSelector: vi.fn(async (_title: string, options: string[]) =>
				options.find((option) => option.startsWith("OpenAI API gateway") || option.startsWith("Read an environment")),
			),
			showExtensionInput: vi.fn(async () => answers.shift()),
			showApiKeyLoginDialog: vi.fn(async () => {}),
			updateAvailableProviderCount: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};
		const ctx = { host: createFakeHost(host), reopen: vi.fn() };
		expect(await showProviderTemplates(ctx.host, ctx.reopen, [])).toBe(true);
		expect(host.showError).not.toHaveBeenCalled();
		const saved = JSON.parse(readFileSync(join(sandbox.agentDir, "models.json"), "utf8"));
		expect(saved.providers["openai-gateway"]).toEqual({
			name: "OpenAI API gateway (Responses)",
			baseUrl: "https://llm.corp.example/openai/v1",
			api: "openai-responses",
			apiKey: "$CORP_LLM_KEY",
			models: [{ id: "gpt-6.1-sol" }],
		});
		expect(host.showApiKeyLoginDialog).not.toHaveBeenCalled();
		expect(host.showStatus.mock.calls[0]?.[0]).toMatch(/Set \$CORP_LLM_KEY/);
		expect(ctx.reopen).toHaveBeenCalledWith("openai-gateway");
	});
});
