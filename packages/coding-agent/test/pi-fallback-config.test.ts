import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { checkAuthFileSafety } from "../src/core/auth-storage/file-safety.ts";
import { PiFallbackCredentialStore } from "../src/core/auth-storage/pi-fallback.ts";
import { ReadOnlyAuthStorage } from "../src/core/auth-storage/read-only.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { runModelDiscoveryCommand } from "../src/main/model-discovery.ts";
import { unsupportedPiSignIn } from "../src/modes/interactive/interactive-mode/provider-pi.ts";
import { providerSourceGate } from "../src/core/provider-sources/index.ts";
import { nativeFeatureSet } from "./helpers/native-features.ts";

let home: string;
let agentDir: string;
function write(file: string, content: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "octocode-pi-fallback-"));
	agentDir = join(home, ".octocode", "octocodecode");
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("OCTOCODE_HOME", "");
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", "");
	vi.stubEnv("CEREBRAS_API_KEY", "");
	vi.stubEnv("GROQ_API_KEY", "");
	vi.stubEnv("ANTHROPIC_API_KEY", "");
	vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
	vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
	providerSourceGate.set({});
});
afterEach(() => {
	providerSourceGate.set({});
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

function createRuntime(): Promise<ModelRuntime> {
	return ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
}

const available = (runtime: ModelRuntime) => new Set(runtime.getAvailableSnapshot().map((model) => model.provider));

describe("fallback auth.json", () => {
	it("skips an unrecognized entry in Pi's auth.json and keeps the other entries", async () => {
		const piAuth = join(home, ".pi", "agent", "auth.json");
		write(piAuth, {
			cerebras: { type: "api_key", key: "pi-key" },
			future: { type: "session-token", token: "x" },
		});
		const runtime = await createRuntime();
		expect(available(runtime)).toContain("cerebras");
		expect(runtime.getError()).toBeUndefined();
	});

	it("skips a fallback auth.json that does not parse", async () => {
		write(join(home, ".octocode", "auth.json"), "{ not json");
		write(join(home, ".pi", "agent", "auth.json"), { cerebras: { type: "api_key", key: "pi-key" } });
		const runtime = await createRuntime();
		expect(available(runtime)).toContain("cerebras");
		expect(runtime.getError()).toBeUndefined();
	});

	it("names the fallback file and entry it skips at startup, and the store still reads the good entries", async () => {
		const piAuth = join(home, ".pi", "agent", "auth.json");
		const legacyAuth = join(home, ".octocode", "auth.json");
		write(piAuth, { cerebras: { type: "api_key", key: "pi-key" }, future: { type: "session-token" } });
		write(legacyAuth, "{ not json");
		const startup = [...checkAuthFileSafety(piAuth), ...checkAuthFileSafety(legacyAuth)].filter((line) =>
			line.startsWith("Skipped"),
		);
		expect(startup).toEqual([
			`Skipped the "future" entry in ${piAuth}: type "session-token" is not api_key or oauth. Its other entries are still used.`,
			`Skipped ${legacyAuth}: it could not be read as JSON, so none of its credentials are used.`,
		]);
		const store = new PiFallbackCredentialStore(AuthStorage.create(join(agentDir, "auth.json")), [
			join(home, ".octocode"),
			join(home, ".pi", "agent"),
		]);
		expect((await store.read("cerebras"))?.type).toBe("api_key");
	});

	it("does not report Octocode's own auth.json as a fallback file", () => {
		const ownAuth = join(agentDir, "auth.json");
		write(ownAuth, { future: { type: "session-token" } });
		expect(checkAuthFileSafety(ownAuth).filter((line) => line.startsWith("Skipped"))).toEqual([]);
	});

	it("reads nothing from fallback files while the pi source is off", () => {
		const piAuth = join(home, ".pi", "agent", "auth.json");
		write(piAuth, { future: { type: "session-token" } });
		providerSourceGate.set({ pi: false });
		expect(checkAuthFileSafety(piAuth).filter((line) => line.startsWith("Skipped"))).toEqual([]);
	});

	it("names the file in a strict read's error", async () => {
		const path = join(home, "strict", "auth.json");
		write(path, { future: { type: "session-token" } });
		await expect(new ReadOnlyAuthStorage(path).list()).rejects.toThrow(path);
	});

	it("uses a literal key from a later fallback file when an earlier one holds a !command", async () => {
		write(join(home, ".pi", "agent", "auth.json"), { cerebras: { type: "api_key", key: "!exit 1" } });
		write(join(home, ".pi", "auth.json"), { cerebras: { type: "api_key", key: "later-pi-key" } });
		const runtime = await createRuntime();
		const auth = await runtime.getAuth("cerebras");
		expect(auth?.auth.apiKey).toBe("later-pi-key");
	});
});

describe("credential precedence across Octocode and Pi", () => {
	it("prefers the apiKey in Octocode's own models.json over a key in Pi's auth.json", async () => {
		write(join(agentDir, "models.json"), { providers: { cerebras: { apiKey: "own-models-key" } } });
		write(join(home, ".pi", "agent", "auth.json"), { cerebras: { type: "api_key", key: "pi-key" } });
		const runtime = await createRuntime();
		expect((await runtime.getAuth("cerebras"))?.auth.apiKey).toBe("own-models-key");
	});

	it("still prefers Octocode's own auth.json over its own models.json apiKey", async () => {
		write(join(agentDir, "models.json"), { providers: { cerebras: { apiKey: "own-models-key" } } });
		write(join(agentDir, "auth.json"), { cerebras: { type: "api_key", key: "own-auth-key" } });
		const runtime = await createRuntime();
		expect((await runtime.getAuth("cerebras"))?.auth.apiKey).toBe("own-auth-key");
	});

	it("keeps Pi's precedence between Pi's own auth.json and Pi's models.json", async () => {
		write(join(home, ".pi", "agent", "models.json"), { providers: { cerebras: { apiKey: "pi-models-key" } } });
		write(join(home, ".pi", "agent", "auth.json"), { cerebras: { type: "api_key", key: "pi-auth-key" } });
		const runtime = await createRuntime();
		expect((await runtime.getAuth("cerebras"))?.auth.apiKey).toBe("pi-auth-key");
	});
});

describe("Pi sign-ins Octocode cannot use", () => {
	it("does not let Pi's Claude OAuth sign-in hide ANTHROPIC_API_KEY", async () => {
		write(join(home, ".pi", "agent", "auth.json"), {
			anthropic: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 },
		});
		vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic-key");
		const runtime = await createRuntime();
		expect(available(runtime)).toContain("anthropic");
		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("env-anthropic-key");
	});
});

describe("models discover", () => {
	it("leaves out Pi's models.json providers while the pi source is off", async () => {
		write(join(home, ".pi", "agent", "models.json"), {
			providers: {
				"pi-local": {
					baseUrl: "https://pi-local.invalid/v1",
					api: "openai-completions",
					apiKey: "local-key",
					models: [{ id: "pi-model" }],
				},
			},
		});
		write(join(agentDir, "settings.json"), { providerSources: { pi: false } });
		vi.spyOn(process, "cwd").mockReturnValue(home);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const exitCode = process.exitCode;
		try {
			expect(await runModelDiscoveryCommand(["models", "discover", "--offline", "--json"])).toBe(true);
			const results = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { provider: string }[];
			expect(results.length).toBeGreaterThan(0);
			expect(results.map((result) => result.provider)).not.toContain("pi-local");
		} finally {
			process.exitCode = exitCode;
			vi.restoreAllMocks();
		}
	});
});

describe("models.json load-time warnings", () => {
	it("warns about a misspelled api and an unknown provider field, naming the file and provider", async () => {
		const path = join(agentDir, "models.json");
		write(path, {
			providers: {
				gateway: {
					baseUrl: "https://gateway.invalid/v1",
					api: "anthropic-message",
					apikey: "k",
					models: [{ id: "m", contextwindow: 1000 }],
				},
			},
		});
		const config = await ModelConfig.loadFile(path);
		expect(config.getError()).toBeUndefined();
		expect(config.getProviderIds()).toEqual(["gateway"]);
		expect(config.getWarnings()).toEqual([
			`${path}: providers.gateway.apikey is not a models.json field and is ignored. Did you mean "apiKey"?`,
			`${path}: providers.gateway.api "anthropic-message" is not a built-in API; requests fail unless a feature provides it. Did you mean "anthropic-messages"?`,
			`${path}: providers.gateway.models[m].contextwindow is not a models.json field and is ignored. Did you mean "contextWindow"?`,
		]);
	});

	it("has no warnings for a valid file, and carries a Pi file's warnings into the merged load", async () => {
		write(join(agentDir, "models.json"), {
			$schema: "x",
			providers: {
				own: { api: "openai-completions", apiKey: "k", baseUrl: "https://own.invalid", models: [{ id: "m" }] },
			},
		});
		const piPath = join(home, ".pi", "agent", "models.json");
		write(piPath, { providers: { piprov: { api: "openai-completion", baseUrl: "https://pi.invalid", models: [] } } });
		expect((await ModelConfig.loadFile(join(agentDir, "models.json"))).getWarnings()).toEqual([]);
		const merged = await ModelConfig.load(join(agentDir, "models.json"));
		expect(merged.getWarnings()).toEqual([
			expect.stringMatching(/^.*\.pi\/agent\/models\.json: providers\.piprov\.api/),
		]);
	});
});

describe("provider page note for a Pi sign-in Octocode cannot use", () => {
	const host = (oauth: boolean, configured = false) =>
		({
			session: {
				modelRuntime: {
					getConfigurationDirectory: () => agentDir,
					getProvider: () => ({ auth: oauth ? { oauth: {} } : { apiKey: {} } }),
					getProviderAuthStatus: () => ({ configured }),
				},
			},
		}) as never;

	it("names Pi's file and says to add an API key", async () => {
		const piAuth = join(home, ".pi", "agent", "auth.json");
		write(piAuth, { anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } });
		expect(await unsupportedPiSignIn(host(false), "anthropic", "Anthropic")).toBe(
			`The account sign-in in ${piAuth} is a type Octocode's Anthropic provider does not support, so it is not used. Add an API key to use it.`,
		);
		expect(await unsupportedPiSignIn(host(true), "anthropic", "Anthropic")).toBeUndefined();
		providerSourceGate.set({ pi: false });
		expect(await unsupportedPiSignIn(host(false), "anthropic", "Anthropic")).toBeUndefined();
	});
});

describe("models.json warnings at startup", () => {
	it("are startup warnings that name the file and provider", async () => {
		const { createAgentSessionServices } = await import("../src/core/agent-session-services.ts");
		const cwd = join(home, "project");
		mkdirSync(cwd, { recursive: true });
		write(join(agentDir, "models.json"), {
			providers: {
				gw: { baseUrl: "http://localhost:1/v1", api: "anthropic-message", apikey: "x", models: [{ id: "m" }] },
			},
		});
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: { nativeFeatures: nativeFeatureSet() },
		});
		const warnings = services.diagnostics.filter((entry) => entry.type === "warning").map((entry) => entry.message);
		expect(
			warnings.some(
				(message) => message.includes("models.json") && message.includes("providers.gw.") && message.includes("apikey"),
			),
		).toBe(true);
		expect(warnings.some((message) => message.includes("anthropic-message"))).toBe(true);
	});
});
