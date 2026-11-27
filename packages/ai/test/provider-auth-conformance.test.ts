import { describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { createModels } from "../src/models.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { amazonBedrockProvider } from "../src/providers/amazon-bedrock.ts";
import { googleProvider } from "../src/providers/google.ts";
import { googleVertexProvider } from "../src/providers/google-vertex.ts";
import { metaProvider } from "../src/providers/meta.ts";

describe("documented provider credential sources", () => {
	it("accepts Meta's documented Model API key variable", async () => {
		const env = { MODEL_API_KEY: "model-api-key" };
		const models = createModels({
			authContext: { env: async (name) => env[name as keyof typeof env], fileExists: async () => false },
		});
		models.setProvider(metaProvider());
		expect(findEnvKeys("meta", env)).toContain("MODEL_API_KEY");
		expect((await models.getAuth("meta"))?.auth.apiKey).toBe("model-api-key");
	});

	it("uses Google's documented key precedence in discovery and request auth", async () => {
		const env = { GOOGLE_API_KEY: "google-key", GEMINI_API_KEY: "gemini-key" };
		const models = createModels({
			authContext: { env: async (name) => env[name as keyof typeof env], fileExists: async () => false },
		});
		models.setProvider(googleProvider());
		expect(findEnvKeys("google", env)).toEqual(["GOOGLE_API_KEY", "GEMINI_API_KEY"]);
		expect(getEnvApiKey("google", env)).toBe("google-key");
		expect((await models.getAuth("google"))?.auth.apiKey).toBe("google-key");
	});

	it("keeps Gemini's existing key variable working", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => (name === "GEMINI_API_KEY" ? "gemini-key" : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider(googleProvider());
		expect((await models.getAuth("google"))?.auth.apiKey).toBe("gemini-key");
	});

	it("delegates explicit AWS credential-chain login to the SDK without env markers", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("amazon-bedrock", async () => ({ type: "api_key" }));
		const models = createModels({
			credentials,
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		models.setProvider(amazonBedrockProvider());
		expect(await models.getAuth("amazon-bedrock")).toMatchObject({ auth: {}, source: "stored credential" });
	});

	it("recognizes AWS shared configuration without a named profile", async () => {
		const models = createModels({
			authContext: { env: async () => undefined, fileExists: async (path) => path === "~/.aws/config" },
		});
		models.setProvider(amazonBedrockProvider());
		expect(await models.getAuth("amazon-bedrock")).toMatchObject({ auth: {}, source: "AWS shared configuration" });
	});

	it("delegates explicitly selected Vertex ADC to the SDK without a credentials file", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("google-vertex", async () => ({
			type: "api_key",
			env: { GOOGLE_CLOUD_PROJECT: "project", GOOGLE_CLOUD_LOCATION: "global" },
		}));
		const models = createModels({
			credentials,
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		models.setProvider(googleVertexProvider());
		expect(await models.getAuth("google-vertex")).toMatchObject({
			auth: {},
			env: { GOOGLE_CLOUD_PROJECT: "project", GOOGLE_CLOUD_LOCATION: "global" },
		});
	});
});
