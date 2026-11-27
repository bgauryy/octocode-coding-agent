import type { ApiKeyCredential, Model, Provider } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const model = (provider: string): Model<"openai-completions"> => ({
	id: "dynamic",
	name: "Dynamic",
	api: "openai-completions",
	provider,
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
});

/** A provider whose model list needs the network, and that records every refresh it is given. */
function dynamicProvider(id: string, refreshed: boolean[]): Provider<"openai-completions"> {
	return {
		id,
		name: id,
		auth: {
			apiKey: {
				name: "API key",
				login: async (): Promise<ApiKeyCredential> => ({ type: "api_key", key: `${id}-key` }),
				check: async ({ credential }) => (credential ? { type: "api_key", source: "stored" } : undefined),
				resolve: async ({ credential }) =>
					credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
			},
		},
		getModels: () => [model(id)],
		refreshModels: async ({ allowNetwork }) => void refreshed.push(allowNetwork),
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

const interaction = { prompt: async () => "unused", notify: () => {} };
const runtimes: ModelRuntime[] = [];

async function setup(allowModelNetwork: boolean) {
	// The suite runs offline; these tests are about the runtime that was created with network access.
	vi.stubEnv("OCTOCODE_OFFLINE", "0");
	const refreshed: boolean[] = [];
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork,
		refreshOnCreate: false,
	});
	runtimes.push(runtime);
	runtime.registerNativeProvider(dynamicProvider("dynamic", refreshed));
	await runtime.refresh({ allowNetwork: false, providers: ["dynamic"] });
	refreshed.length = 0;
	return { runtime, refreshed };
}

afterEach(() => {
	runtimes.splice(0).forEach((runtime) => runtime.dispose());
	vi.unstubAllEnvs();
});

describe("model refresh after a credential change", () => {
	it("a login schedules one network refresh of that provider", async () => {
		const { runtime, refreshed } = await setup(true);
		await runtime.login("dynamic", "api_key", interaction);
		await vi.waitFor(() => expect(refreshed).toContain(true));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(refreshed.filter((allowNetwork) => allowNetwork)).toHaveLength(1);
	});

	it("an imported credential does too; a logout does not", async () => {
		const { runtime, refreshed } = await setup(true);
		await runtime.importCredential("dynamic", { type: "api_key", key: "k" });
		await vi.waitFor(() => expect(refreshed.filter(Boolean)).toHaveLength(1));
		await runtime.logout("dynamic");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(refreshed.filter(Boolean)).toHaveLength(1);
	});

	it("never goes to the network when the runtime was created without it", async () => {
		const { runtime, refreshed } = await setup(false);
		await runtime.login("dynamic", "api_key", interaction);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(refreshed).not.toContain(true);
	});
});
