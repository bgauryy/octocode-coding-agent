import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { templateProviderEntry } from "../src/core/provider-templates/apply.ts";
import { PROVIDER_TEMPLATES } from "../src/core/provider-templates/templates.ts";
import { showProviderTemplates } from "../src/modes/interactive/interactive-mode/provider-template.ts";
import { createSandbox, type Sandbox } from "./discovery/fixtures.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

describe("local model template setup", () => {
	let sandbox: Sandbox;
	const runtimes: ModelRuntime[] = [];
	beforeEach(() => {
		sandbox = createSandbox();
	});
	afterEach(() => {
		for (const runtime of runtimes.splice(0)) runtime.dispose();
		sandbox.cleanup();
	});

	async function createRuntime() {
		const runtime = await ModelRuntime.create({
			modelsPath: join(sandbox.agentDir, "models.json"),
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
		runtimes.push(runtime);
		return runtime;
	}

	async function setup(answers: (string | undefined)[]) {
		const runtime = await createRuntime();
		const host = createFakeHost({
			session: { modelRuntime: runtime },
			showSelectorDialog: vi.fn(async (_title: string, options: string[]) =>
				options.find((option) => option.startsWith("Ollama —") || option.startsWith("No key")),
			),
			showInputDialog: vi.fn(async () => answers.shift()),
			showApiKeyLoginDialog: vi.fn(async () => {}),
			updateAvailableProviderCount: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		});
		const added = await showProviderTemplates(host, vi.fn(), []);
		return { runtime, host, added };
	}

	test("persists each model's server limits and restores selectable local models without hosted metadata", async () => {
		const { runtime, host, added } = await setup(["", "qwen3:8b, gpt-6.1-sol", "4096", "1024", "32768", "4096"]);
		expect(added).toBe(true);
		expect(host.showError).not.toHaveBeenCalled();
		const stored = JSON.parse(readFileSync(join(sandbox.agentDir, "models.json"), "utf8"));
		expect(stored.providers.ollama.models).toEqual([
			{
				id: "qwen3:8b",
				contextWindow: 4096,
				maxTokens: 1024,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{
				id: "gpt-6.1-sol",
				contextWindow: 32768,
				maxTokens: 4096,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		]);
		expect((await runtime.getAvailable("ollama")).map((model) => model.id)).toEqual(["qwen3:8b", "gpt-6.1-sol"]);
		const reopened = await createRuntime();
		for (const definition of stored.providers.ollama.models) {
			const model = reopened.getModel("ollama", definition.id)!;
			expect(model).toMatchObject(definition);
			expect(await reopened.getAuth(model)).toMatchObject({ auth: { apiKey: "no-key" } });
		}
	});

	test("retries invalid limits, permits equal context/output limits and writes only validated values", async () => {
		const { host, added } = await setup(["", "local-model", "0", "8k", "9000", "8k"]);
		expect(added).toBe(true);
		expect(host.showError).toHaveBeenCalledTimes(2);
		const saved = JSON.parse(readFileSync(join(sandbox.agentDir, "models.json"), "utf8"));
		expect(saved.providers.ollama.models[0]).toMatchObject({ contextWindow: 8000, maxTokens: 8000 });
	});

	test("cancelling local limits leaves the provider unconfigured", async () => {
		const { host, added } = await setup(["", "local-model", undefined]);
		expect(added).toBe(false);
		expect(existsSync(join(sandbox.agentDir, "models.json"))).toBe(false);
		expect(host.showApiKeyLoginDialog).not.toHaveBeenCalled();
	});

	test("explicit local capabilities and prices remain configurable", () => {
		const template = PROVIDER_TEMPLATES.find((entry) => entry.id === "ollama")!;
		const model = {
			id: "custom-model",
			reasoning: true,
			input: ["text", "image"] as ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		};
		expect(templateProviderEntry(template, { key: { kind: "none" }, models: [model] }).models).toEqual([model]);
	});
});
