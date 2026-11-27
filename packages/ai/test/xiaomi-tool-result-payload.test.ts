import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Context } from "../src/types.ts";

/**
 * The client side of the skipped live Xiaomi text-and-image case (image-tool-result.test.ts): the request carries both
 * the text and the image of a tool result, so a reply that ignores the image is the model's doing.
 */
describe("Xiaomi MiMo tool result payload", () => {
	it("sends a tool result's text and image together", async () => {
		const model = getBuiltinModel("xiaomi", "mimo-v2.6-pro");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "get_circle", arguments: {} }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Describe the circle", timestamp: Date.now() },
				assistant,
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "get_circle",
					content: [
						{ type: "text", text: "The circle has a diameter of 100 pixels." },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
					],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};
		let payload: unknown;
		const stream = streamSimple(model, context, {
			apiKey: "fake-key",
			onPayload: (body) => {
				payload = body;
				throw new Error("payload captured");
			},
		});
		await stream.result();
		const text = JSON.stringify(payload);
		expect(text).toContain("The circle has a diameter of 100 pixels.");
		expect(text).toContain("AAAA");
	});
});
