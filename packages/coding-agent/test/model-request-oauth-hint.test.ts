import { type Model, ModelsError } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { type ModelRequestHost, streamChatModel } from "../src/core/model-runtime/requests.ts";

const model = {
	id: "gpt-test",
	name: "GPT test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1_000,
} as Model<"openai-responses">;

function hostFailingAuth(error: Error): ModelRequestHost {
	return {
		getProvider: () => ({ id: "openai" }) as ReturnType<ModelRequestHost["getProvider"]>,
		getAuth: async () => {
			throw error;
		},
		getCachePolicy: () => ({ options: {} }) as ReturnType<ModelRequestHost["getCachePolicy"]>,
		resolveModel: async () => {
			throw new Error("not routed");
		},
		streamSimple: () => {
			throw new Error("not used");
		},
	};
}

describe("model request auth failures", () => {
	it("turns a failed OAuth renewal into a sign-in hint that keeps the provider's reason", async () => {
		const failure = new ModelsError("oauth", "OAuth refresh failed for openai", {
			cause: new Error("OpenAI OAuth token request failed (400 invalid_grant)"),
		});
		const result = await streamChatModel(hostFailingAuth(failure), model, { messages: [] }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(
			"Sign-in for openai could not be renewed. Type /providers openai to sign in again. (OAuth refresh failed for openai: OpenAI OAuth token request failed (400 invalid_grant))",
		);
	});

	it("leaves other auth failures unchanged", async () => {
		const result = await streamChatModel(
			hostFailingAuth(new ModelsError("auth", "Credential store modify failed for openai")),
			model,
			{ messages: [] },
		).result();

		expect(result.errorMessage).toBe("Credential store modify failed for openai");
	});
});
