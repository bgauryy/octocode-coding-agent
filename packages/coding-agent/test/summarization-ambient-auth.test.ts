import { Agent } from "@octocodeai/octocode-agent-core";
import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { streamSimple } from "@octocodeai/octocode-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import { getSummarizationRequestAuth } from "../src/core/agent-session/request-auth.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("summarization with ambient authentication", () => {
	let runtime: ModelRuntime | undefined;
	afterEach(() => runtime?.dispose());

	test.each([
		["amazon-bedrock", { AWS_PROFILE: "fixture-profile" }],
		["google-vertex", { GOOGLE_CLOUD_PROJECT: "fixture-project", GOOGLE_CLOUD_LOCATION: "us-central1" }],
	] as const)(
		"preserves resolved %s credential-chain configuration without requiring an API key",
		async (provider, env) => {
			runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({ [provider]: { type: "api_key", env } }),
				modelsPath: null,
				modelsStore: new InMemoryModelsStore(),
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			const model = runtime.getModels(provider)[0];
			expect(model).toBeDefined();
			expect(await runtime.getAuth(model)).toMatchObject({ auth: {}, env });
			const agent = new Agent({ streamFn: streamSimple });
			await expect(
				getSummarizationRequestAuth({ modelRuntime: runtime, agent, messages: [], thinkingLevel: "off" }, model),
			).resolves.toMatchObject({ model, env, thinkingLevel: "off" });
		},
	);

	test("still refuses a summary when the provider has no resolved authentication", async () => {
		runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const model = { ...runtime.getModels("amazon-bedrock")[0], provider: "unconfigured-fixture" };
		const agent = new Agent({ streamFn: streamSimple });
		await expect(
			getSummarizationRequestAuth({ modelRuntime: runtime, agent, messages: [], thinkingLevel: "off" }, model),
		).rejects.toThrow("No usable credentials for unconfigured-fixture");
	});
});
