import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "../src/models.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { azureProvider } from "../src/providers/azure.ts";

function response(): Response {
	return new Response(
		`data: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe("Azure Microsoft Entra authentication", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("resolves an externally refreshed bearer token instead of an API key", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => (name === "AZURE_OPENAI_AD_TOKEN" ? "entra-token" : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider(azureProvider());
		expect(await models.getAuth("azure")).toMatchObject({
			auth: { headers: { Authorization: "Bearer entra-token", "api-key": null } },
		});
	});

	it("sends Entra bearer authentication on the real Responses SDK request", async () => {
		vi.stubEnv("AZURE_OPENAI_API_KEY", "ambient-key-must-not-win");
		const provider = azureProvider();
		const model = provider.getModels().find((entry) => entry.api === "azure-openai-responses")!;
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			expect(request.headers.get("authorization")).toBe("Bearer entra-token");
			expect(request.headers.get("api-key")).toBeNull();
			return response();
		});
		const output = await provider
			.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }), {
				headers: { Authorization: "Bearer entra-token", "api-key": null },
				env: { AZURE_OPENAI_BASE_URL: "https://resource.openai.azure.com" },
				fetch,
			})
			.result();
		expect(output.stopReason, output.errorMessage).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
	});
});
