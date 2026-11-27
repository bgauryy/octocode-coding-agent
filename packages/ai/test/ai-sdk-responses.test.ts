import { describe, expect, it, vi } from "vitest";
import { stream as openai } from "../src/api/openai-responses.ts";
import { stream as azure } from "../src/api/azure-openai-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const base = {
	id: "test-model",
	name: "Test",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
function response() {
	const message = {
		type: "message",
		id: "msg_1",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "hello", annotations: [] }],
	};
	const events = [
		{ type: "response.created", response: { id: "resp_1", created_at: 1, model: "test-model" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
		{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hello" },
		{ type: "response.output_item.done", output_index: 0, item: message },
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				created_at: 1,
				model: "test-model",
				status: "completed",
				output: [message],
				usage: {
					input_tokens: 10,
					output_tokens: 2,
					total_tokens: 12,
					input_tokens_details: { cached_tokens: 3 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			},
		},
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

describe("shared Responses SDK transport", () => {
	it.each(["openai-responses", "azure-openai-responses"] as const)(
		"keeps %s storage, output and usage contracts",
		async (api) => {
			const request = vi.fn<typeof globalThis.fetch>(async () => response());
			const result =
				api === "openai-responses"
					? await openai({ ...base, api, provider: "openai", baseUrl: "https://proxy.invalid/v1" }, context, {
							apiKey: "test",
							fetch: request,
						}).result()
					: await azure({ ...base, api, provider: "azure", baseUrl: "https://proxy.invalid/v1" }, context, {
							apiKey: "test",
							fetch: request,
						}).result();
			expect(result.errorMessage).toBeUndefined();
			expect(result).toMatchObject({
				api,
				responseId: "resp_1",
				stopReason: "stop",
				content: [{ type: "text", text: "hello", textSignature: JSON.stringify({ v: 1, id: "msg_1" }) }],
				usage: { input: 7, output: 2, cacheRead: 3, totalTokens: 12 },
			});
			const payload = JSON.parse(String(request.mock.calls[0][1]?.body));
			expect(payload.store).toBe(false);
			expect(request).toHaveBeenCalledOnce();
		},
	);

	it("delivers original OpenAI chunks once while raw SDK chunks are enabled", async () => {
		const request = vi.fn<typeof globalThis.fetch>(async () => response());
		const observed: unknown[] = [];
		const result = await openai(
			{ ...base, api: "openai-responses", provider: "openai", baseUrl: "https://proxy.invalid/v1" },
			context,
			{
				apiKey: "sk-test",
				fetch: request,
				onProviderStreamEvent: (event) => {
					observed.push(event);
				},
			},
		).result();
		expect(result.errorMessage).toBeUndefined();
		expect(request).toHaveBeenCalledOnce();
		expect(observed.map((event) => (event as { type: string }).type)).toEqual([
			"response.created",
			"response.output_item.added",
			"response.output_text.delta",
			"response.output_item.done",
			"response.completed",
		]);
		expect(result.content).toMatchObject([{ type: "text", text: "hello" }]);
	});

	it("refreshes the Entra token and keeps the deployment name", async () => {
		const model: Model<"azure-openai-responses"> = {
			...base,
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: "https://example.openai.azure.com/openai/v1",
		};
		const request = vi.fn<typeof globalThis.fetch>(async () => response());
		const token = vi.fn(async () => "test-token");
		const result = await azure(model, context, {
			apiKey: "",
			azureADTokenProvider: token,
			azureDeploymentName: "my-deployment",
			fetch: request,
		}).result();
		expect(result.errorMessage).toBeUndefined();
		expect(token).toHaveBeenCalledOnce();
		expect(new Headers(request.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer test-token");
		expect(JSON.parse(String(request.mock.calls[0][1]?.body)).model).toBe("my-deployment");
	});
});
