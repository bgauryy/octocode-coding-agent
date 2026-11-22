import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir, getLegacyConfigDirs, getModelsPath, getOctocodeHome, getSessionsDir } from "../src/config.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { globalPaths } from "../src/octocode/shared/home.ts";
import { nativeFeatureSet } from "./helpers/native-features.ts";

let home: string;
let cwd: string;
function write(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "octocode-native-config-"));
	cwd = join(home, "project");
	mkdirSync(cwd);
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("OCTOCODE_HOME", "");
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("Octocode home and Pi configuration fallback", () => {
	it("uses one native root and preserves explicit isolation", () => {
		const native = join(home, ".octocode", "octocodecode");
		expect(getAgentDir()).toBe(native);
		expect(globalPaths().home).toBe(native);
		expect(getSessionsDir()).toBe(join(native, "sessions"));
		expect(getOctocodeHome({ OCTOCODE_HOME: "~/custom" }, home)).toBe(join(home, "custom"));
		expect(getLegacyConfigDirs()).toEqual([join(home, ".pi", "agent"), join(home, ".pi")]);
		vi.stubEnv("OCTOCODE_HOME", join(home, "isolated"));
		expect(getAgentDir()).toBe(join(home, "isolated"));
		expect(getLegacyConfigDirs()).toEqual([]);
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", join(home, "sdk"));
		expect(getAgentDir()).toBe(join(home, "sdk"));
	});

	it("merges model providers with native precedence and refreshes from disk", async () => {
		write(
			join(home, ".pi", "models.json"),
			JSON.stringify({ providers: { root: { baseUrl: "https://root.invalid" } } }),
		);
		write(
			join(home, ".pi", "agent", "models.json"),
			JSON.stringify({
				providers: {
					shared: { apiKey: "legacy-key", baseUrl: "https://legacy.invalid" },
					legacy: { baseUrl: "https://legacy.invalid" },
				},
			}),
		);
		write(getModelsPath(), JSON.stringify({ providers: { shared: { baseUrl: "https://native.invalid" } } }));
		const config = await ModelConfig.load(getModelsPath());
		expect(config.getError()).toBeUndefined();
		expect([...config.getProviderIds()].sort()).toEqual(["legacy", "root", "shared"]);
		expect(config.getProvider("shared")).toEqual({ baseUrl: "https://native.invalid" });
		write(getModelsPath(), JSON.stringify({ providers: { changed: { baseUrl: "https://changed.invalid" } } }));
		expect((await ModelConfig.load(getModelsPath())).getProvider("changed")).toBeDefined();
		expect((await ModelConfig.load(join(home, "custom-models.json"))).getProviderIds()).toEqual([]);
	});

	it("reports malformed fallback models instead of hiding the error", async () => {
		const legacy = join(home, ".pi", "agent", "models.json");
		write(legacy, "{broken");
		expect((await ModelConfig.load(getModelsPath())).getError()).toContain(legacy);
	});

	it("reports errors of concurrently loaded models files in precedence order", async () => {
		const agent = join(home, ".pi", "agent", "models.json");
		const root = join(home, ".pi", "models.json");
		write(getModelsPath(), "{native broken");
		write(agent, "{agent broken");
		write(root, "{root broken");
		const error = (await ModelConfig.load(getModelsPath())).getError() ?? "";
		const order = [getModelsPath(), agent, root].map((file) => error.indexOf(`File: ${file}`));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it("loads image capabilities and limits from Pi provider definitions and model overrides", async () => {
		const legacy = join(home, ".pi", "agent", "models.json");
		const content = JSON.stringify({
			providers: {
				"pi-vision": {
					api: "openai-completions",
					baseUrl: "https://vision.invalid/v1",
					apiKey: "fixture-key",
					models: [
						{ id: "vision", input: ["text", "image"], inputLimits: { images: { maxPerRequest: 3 } } },
						{ id: "unconfigured" },
					],
				},
				openai: { modelOverrides: { "gpt-4o": { inputLimits: { images: { maxPerMessage: 2 } } } } },
			},
		});
		write(legacy, content);
		const registry = await createModelRegistry(AuthStorage.inMemory(), getModelsPath());
		expect(registry.getError()).toBeUndefined();
		expect(registry.find("pi-vision", "vision")).toMatchObject({
			input: ["text", "image"],
			inputLimits: { images: { maxPerRequest: 3 } },
		});
		expect(registry.find("pi-vision", "unconfigured")?.input).toEqual(["text"]);
		expect(registry.find("openai", "gpt-4o")).toMatchObject({
			input: ["text", "image"],
			inputLimits: { images: { maxPerMessage: 2 } },
		});
		write(
			getModelsPath(),
			JSON.stringify({
				providers: {
					"pi-vision": {
						api: "openai-completions",
						baseUrl: "https://native.invalid/v1",
						models: [{ id: "vision", input: ["text"] }],
					},
				},
			}),
		);
		await registry.refresh();
		expect(registry.find("pi-vision", "vision")?.input).toEqual(["text"]);
		expect(readFileSync(legacy, "utf8")).toBe(content);
	});

	it("inherits settings without importing trust or state and writes only native settings", async () => {
		const legacy = join(home, ".pi", "agent", "settings.json");
		const content = JSON.stringify({
			defaultModel: "legacy",
			terminal: { showImages: false },
			defaultProjectTrust: "always",
			sessionDir: "/old-sessions",
		});
		write(legacy, content);
		write(join(getAgentDir(), "settings.json"), JSON.stringify({ defaultModel: "native" }));
		const settings = SettingsManager.create(cwd);
		expect(settings.getDefaultModel()).toBe("native");
		expect(settings.getShowImages()).toBe(false);
		expect((settings.getGlobalSettings() as Record<string, unknown>).defaultProjectTrust).toBeUndefined();
		expect(settings.getSessionDir()).toBeUndefined();
		settings.setDefaultModel("updated");
		await settings.flush();
		expect(settings.drainErrors()).toEqual([]);
		expect(JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")).defaultModel).toBe("updated");
		expect(readFileSync(legacy, "utf8")).toBe(content);
	});

	it("does not load the legacy Octocode extension alongside native features", async () => {
		const legacy = join(home, ".pi", "agent");
		write(
			join(legacy, "old-octocode", "package.json"),
			JSON.stringify({ name: "@octocodeai/pi-extension", pi: { extensions: ["./entry.ts"] } }),
		);
		write(join(legacy, "old-octocode", "entry.ts"), 'throw new Error("duplicate Octocode extension executed");');
		write(join(legacy, "settings.json"), JSON.stringify({ packages: ["./old-octocode"] }));
		const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), nativeFeatures: nativeFeatureSet() });
		await loader.reload();
		expect(loader.getFeatures().errors).toEqual([]);
		expect(loader.getFeatures().features.some((feature) => feature.path === "<inline:octocode>")).toBe(true);
	});
});
