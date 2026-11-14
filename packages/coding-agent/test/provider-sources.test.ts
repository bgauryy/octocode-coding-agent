import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	applyProviderSources,
	describeProviderSources,
	detectLocalTools,
	providerSourceGate,
} from "../src/core/provider-sources/index.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const SYNTHETIC_COPILOT_VALUE = "ghu_synthetic_value_for_tests";

let home: string;
function write(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "octocode-provider-sources-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("OCTOCODE_HOME", "");
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", "");
	vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
	vi.stubEnv("CEREBRAS_API_KEY", "");
	providerSourceGate.set({});
});
afterEach(() => {
	providerSourceGate.set({});
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

async function createRuntime(): Promise<ModelRuntime> {
	const agentDir = join(home, ".octocode", "octocodecode");
	return ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
}

const providers = (registry: ModelRegistry) => new Set(registry.getAvailable().map((model) => model.provider));

describe("provider source defaults", () => {
	it("has Octocode and Pi on, COPILOT_GITHUB_TOKEN off, and only Pi and the variable toggleable", () => {
		const sources = describeProviderSources({}, { home, env: {}, agentDir: join(home, ".octocode", "octocodecode") });
		expect(
			sources.map((source) => [source.id, source.defaultEnabled, source.toggleable, source.state.enabled]),
		).toEqual([
			["octocode", true, false, true],
			["pi", true, true, true],
			["copilot-env", false, true, false],
		]);
		expect(sources[1]?.paths).toContain("~/.pi/agent/auth.json");
	});

	it("ignores an attempt to switch off Octocode and values equal to the defaults", () => {
		const sources = describeProviderSources({ octocode: false, pi: true, "copilot-env": true }, { home, env: {} });
		expect(sources.map((source) => source.state.enabled)).toEqual([true, true, true]);
		expect(sources.map((source) => source.state.overridden)).toEqual([false, false, true]);
	});

	it("stores only changes from the defaults, in the global file only", () => {
		const agentDir = join(home, "agent");
		const project = join(home, "project");
		mkdirSync(project, { recursive: true });
		write(join(project, ".octocode", "settings.json"), JSON.stringify({ providerSources: { pi: false } }));
		const settings = SettingsManager.create(project, agentDir);
		expect(settings.getProviderSources()).toEqual({});
		settings.setProviderSourceEnabled("pi", false);
		settings.setProviderSourceEnabled("copilot-env", true);
		expect(settings.getProviderSources()).toEqual({ pi: false, "copilot-env": true });
		settings.setProviderSourceEnabled("pi", true);
		expect(settings.getProviderSources()).toEqual({ "copilot-env": true });
	});
});

describe("Pi source", () => {
	it("loads Octocode and Pi model files with default runtime paths and keeps Octocode on when Pi is disabled", async () => {
		const roots = [
			["octocode", join(home, ".octocode", "octocodecode")],
			["legacy-agent", join(home, ".octocode", "agent")],
			["legacy-root", join(home, ".octocode")],
			["pi-agent", join(home, ".pi", "agent")],
			["pi-root", join(home, ".pi")],
		] as const;
		for (const [id, dir] of roots) {
			const definition = {
				baseUrl: `https://${id}.invalid/v1`,
				api: "openai-completions",
				apiKey: "synthetic-key",
				models: [{ id: `${id}-model` }],
			};
			write(
				join(dir, "models.json"),
				JSON.stringify({ providers: { [`default-${id}`]: definition, "default-shared": definition } }),
			);
		}
		const runtime = await ModelRuntime.create({
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime);
		for (const [id] of roots) expect(providers(registry)).toContain(`default-${id}`);
		expect(
			registry
				.getAll()
				.filter((model) => model.provider === "default-shared")
				.map(({ id, baseUrl }) => ({ id, baseUrl })),
		).toEqual([{ id: "octocode-model", baseUrl: "https://octocode.invalid/v1" }]);

		await applyProviderSources(runtime, { pi: false });
		expect(providers(registry)).toContain("default-octocode");
		expect(providers(registry)).toContain("default-shared");
		for (const [id] of roots.slice(1)) expect(providers(registry)).not.toContain(`default-${id}`);
	});

	it("hides Pi-only credentials and models.json providers when off, and restores them when on", async () => {
		write(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ cerebras: { type: "api_key", key: "pi-key" } }));
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
		const runtime = await createRuntime();
		const registry = new ModelRegistry(runtime);
		expect(providers(registry)).toContain("cerebras");
		expect(providers(registry)).toContain("pi-local");

		await applyProviderSources(runtime, { pi: false });
		expect(providers(registry)).not.toContain("cerebras");
		expect(providers(registry)).not.toContain("pi-local");
		expect(registry.getAll().some((model) => model.provider === "pi-local")).toBe(false);

		await applyProviderSources(runtime, {});
		expect(providers(registry)).toContain("cerebras");
		expect(providers(registry)).toContain("pi-local");
	});
});

describe("copilot-env source", () => {
	it("supplies github-copilot only when on, labelled with the variable name and never the value", async () => {
		vi.stubEnv("COPILOT_GITHUB_TOKEN", SYNTHETIC_COPILOT_VALUE);
		const runtime = await createRuntime();
		const registry = new ModelRegistry(runtime);
		expect(providers(registry)).not.toContain("github-copilot");
		expect(registry.getProviderAuthStatus("github-copilot").configured).toBe(false);

		await applyProviderSources(runtime, { "copilot-env": true });
		expect(providers(registry)).toContain("github-copilot");
		const status = registry.getProviderAuthStatus("github-copilot");
		expect(status).toMatchObject({ configured: true, label: "COPILOT_GITHUB_TOKEN" });

		const shown = JSON.stringify([
			status,
			describeProviderSources(
				{ "copilot-env": true },
				{ home, env: { COPILOT_GITHUB_TOKEN: SYNTHETIC_COPILOT_VALUE } },
			),
		]);
		expect(shown).not.toContain(SYNTHETIC_COPILOT_VALUE);
		expect(shown).toContain('"present":true');

		await applyProviderSources(runtime, {});
		expect(providers(registry)).not.toContain("github-copilot");
	});
});

describe("detected tools", () => {
	const ids = (env: Record<string, string> = {}) => detectLocalTools({ home, env }).map((tool) => tool.id);

	it("finds nothing in an empty home", () => {
		expect(ids()).toEqual([]);
	});

	it("finds tools by documented paths and gives each its action", () => {
		for (const dir of [".claude", ".codex", ".grok", ".gemini", ".copilot", ".config/opencode", ".qwen"]) {
			mkdirSync(join(home, dir), { recursive: true });
		}
		write(join(home, ".aider.conf.yml"), "");
		const tools = detectLocalTools({ home, env: {} });
		expect(Object.fromEntries(tools.map((tool) => [tool.id, tool.action]))).toEqual({
			"claude-code": { kind: "api-key", providerId: "anthropic" },
			"codex-cli": { kind: "sign-in", providerId: "openai", alternativeProviderIds: ["openai-codex"] },
			"grok-cli": { kind: "sign-in", providerId: "xai" },
			"gemini-cli": { kind: "api-key", providerId: "google" },
			"copilot-cli": { kind: "sign-in", providerId: "github-copilot" },
			opencode: { kind: "api-key", providerId: "opencode" },
			"qwen-code": { kind: "api-key", providerId: "qwen-token-plan" },
			aider: { kind: "api-key", providerId: "openai" },
		});
		expect(tools.find((tool) => tool.id === "codex-cli")?.foundAt).toEqual(["~/.codex"]);
	});

	it("follows CODEX_HOME", () => {
		mkdirSync(join(home, "elsewhere"));
		expect(ids({ CODEX_HOME: join(home, "elsewhere") })).toEqual(["codex-cli"]);
	});

	it("does not report Cursor for an `agent` launcher that links to Grok", () => {
		mkdirSync(join(home, ".grok", "bin"), { recursive: true });
		write(join(home, ".grok", "bin", "agent"), "");
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		symlinkSync(join(home, ".grok", "bin", "agent"), join(home, ".local", "bin", "agent"));
		expect(ids()).toEqual(["grok-cli"]);
	});

	it("reports Cursor for an `agent` launcher that links into Cursor's install", () => {
		const target = join(home, ".local", "share", "cursor-agent", "versions", "1", "cursor-agent");
		write(target, "");
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		symlinkSync(target, join(home, ".local", "bin", "agent"));
		const cursor = detectLocalTools({ home, env: {} }).find((tool) => tool.id === "cursor");
		expect(cursor?.foundAt).toEqual(["~/.local/bin/agent"]);
	});
});
