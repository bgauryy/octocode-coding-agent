import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	onProviderSettingsApplied,
	providerSourceGate,
	watchProviderSettings,
} from "../src/core/provider-sources/index.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let home: string;
const stops: Array<() => void> = [];
function write(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "octocode-provider-watch-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("OCTOCODE_HOME", "");
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", "");
	providerSourceGate.set({});
});
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	providerSourceGate.set({});
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

const providers = (runtime: ModelRuntime) => new Set(runtime.getAvailableSnapshot().map((model) => model.provider));

describe("provider switches saved by another process", () => {
	it("a running runtime drops and restores a provider another manager disables", async () => {
		const agentDir = join(home, "agent");
		write(join(agentDir, "settings.json"), "{}");
		write(join(agentDir, "auth.json"), JSON.stringify({ cerebras: { type: "api_key", key: "k" } }));
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
		const running = SettingsManager.create(join(home, "project"), agentDir);
		let applied = 0;
		const session = { model: undefined, modelRuntime: runtime, sendCustomMessage: async () => {} };
		stops.push(
			onProviderSettingsApplied(session, () => applied++),
			watchProviderSettings(running, runtime, session),
		);
		expect(providers(runtime)).toContain("cerebras");

		const other = SettingsManager.create(join(home, "project"), agentDir);
		other.setDisabledProviders(["cerebras"]);
		await other.flush();
		await expect.poll(() => providers(runtime), { timeout: 5000 }).not.toContain("cerebras");
		expect(running.getDisabledProviders()).toEqual(["cerebras"]);

		other.setDisabledProviders([]);
		await other.flush();
		await expect.poll(() => providers(runtime), { timeout: 5000 }).toContain("cerebras");
		await expect.poll(() => applied, { timeout: 5000 }).toBe(2);
	});

	it("hides a Pi-defined provider when another manager turns the Pi source off, and keeps own saves quiet", async () => {
		const agentDir = join(home, "agent");
		write(join(agentDir, "settings.json"), "{}");
		write(
			join(home, ".pi", "agent", "models.json"),
			JSON.stringify({
				providers: {
					"pi-local": {
						baseUrl: "https://pi-local.invalid/v1",
						api: "openai-completions",
						apiKey: "local-key",
						models: [{ id: "pi-model" }],
					},
				},
			}),
		);
		const runtime = await ModelRuntime.create({
			authPath: join(home, ".octocode", "octocodecode", "auth.json"),
			modelsPath: join(home, ".octocode", "octocodecode", "models.json"),
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
		const running = SettingsManager.create(join(home, "project"), agentDir);
		let applied = 0;
		const session = { model: undefined, modelRuntime: runtime, sendCustomMessage: async () => {} };
		stops.push(
			onProviderSettingsApplied(session, () => applied++),
			watchProviderSettings(running, runtime, session),
		);
		const registry = new ModelRegistry(runtime);
		const piProviders = () => new Set(registry.getAvailable().map((model) => model.provider));
		expect(piProviders()).toContain("pi-local");

		running.setProviderSourceEnabled("copilot-env", false);
		await running.flush();
		await new Promise((resolve) => setTimeout(resolve, 2500));
		expect(applied).toBe(0);

		const other = SettingsManager.create(join(home, "project"), agentDir);
		other.setProviderSourceEnabled("pi", false);
		await other.flush();
		await expect.poll(() => piProviders(), { timeout: 5000 }).not.toContain("pi-local");
		other.setProviderSourceEnabled("pi", true);
		await other.flush();
		await expect.poll(() => piProviders(), { timeout: 5000 }).toContain("pi-local");
	});
});
