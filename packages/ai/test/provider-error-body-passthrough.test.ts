import { describe, expect, it } from "vitest";
import { generateImages } from "../src/images.ts";
import type { ImageModel } from "../src/types.ts";

describe("provider error body passthrough", () => {
	it("surfaces HTTP status and gateway body for OpenRouter images", async () => {
		const model: ImageModel<"openrouter-images"> = {
			type: "image",
			id: "fixture",
			name: "Fixture",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
		};
		const output = await generateImages(
			model,
			{ input: [{ type: "text", text: "Generate a dog" }] },
			{
				apiKey: "test",
				fetch: async () => Response.json({ error: "blocked by gateway WAF" }, { status: 403 }),
			},
		);
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("403");
		expect(output.errorMessage).toContain("blocked by gateway WAF");
	});
});
