import { describe, expect, it } from "vitest";
import { generateImages } from "../src/api/openrouter-images.ts";
import type { ImageModel, ProviderHeaders } from "../src/types.ts";

const model: ImageModel<"openrouter-images"> = {
	type: "image",
	id: "image-model",
	name: "Image model",
	api: "openrouter-images",
	provider: "openrouter",
	baseUrl: "https://images.test/v1",
	input: ["text"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	headers: { "X-Source": "model", "X-Remove": "model" },
};

describe("OpenRouter image HTTP headers", () => {
	it("keeps tenant and custom environment defaults below request overrides", async () => {
		let sent = new Headers();
		const result = await generateImages(
			model,
			{ input: [] },
			{
				apiKey: "fixture",
				env: { OPENAI_ORG_ID: "org", OPENAI_PROJECT_ID: "project", OPENAI_CUSTOM_HEADERS: "x-extra: value" },
				headers: { "openai-project": null },
				fetch: async (_url, init) => {
					sent = new Headers(init?.headers);
					return Response.json({ id: "image", choices: [] });
				},
			},
		);
		expect(result.stopReason).toBe("stop");
		expect(sent.get("openai-organization")).toBe("org");
		expect(sent.has("openai-project")).toBe(false);
		expect(sent.get("x-extra")).toBe("value");
	});
	const cases: Array<{ headers: ProviderHeaders; expected: string | null }> = [
		{ headers: { Authorization: null }, expected: null },
		{
			headers: { authorization: "Bearer override" },
			expected: "Bearer override",
		},
		{ headers: {}, expected: "Bearer test-key" },
	];
	it.each(cases)("preserves auth header overrides: $expected", async ({ headers, expected }) => {
		let sent: Headers | undefined;
		const result = await generateImages(
			model,
			{ input: [{ type: "text", text: "Draw a tree" }] },
			{
				apiKey: "test-key",
				headers: { ...headers, "x-source": "request", "x-remove": null },
				fetch: async (_url, init) => {
					sent = new Headers(init?.headers);
					return Response.json({
						id: "image-response",
						choices: [
							{
								message: {
									images: [{ image_url: "data:image/png;base64,YQ==" }],
								},
							},
						],
					});
				},
			},
		);
		expect(result.stopReason).toBe("stop");
		expect(sent?.get("authorization")).toBe(expected);
		expect(sent?.get("x-source")).toBe("request");
		expect(sent?.has("x-remove")).toBe(false);
	});
});
