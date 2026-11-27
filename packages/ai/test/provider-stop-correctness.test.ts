import { completionsResponse, mockCompletionsFetch } from "./completions-fetch-fixture.ts";
import { describe, expect, it, vi } from "vitest";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const chunks = vi.hoisted(() => ({ list: [] as unknown[] }));
mockCompletionsFetch(() =>
	completionsResponse({
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks.list) yield chunk;
		},
	}),
);

const completionsModel: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};
const responsesModel: Model<"openai-responses"> = { ...completionsModel, api: "openai-responses", id: "gpt-5-mini" };
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

describe("provider stop reasons", () => {
	it("Chat Completions: tool calls with finish_reason stop end as toolUse", async () => {
		const call = { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } };
		chunks.list = [
			{ id: "c1", choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] },
			{ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		];
		const message = await streamCompletions(completionsModel, context, { apiKey: "k" }).result();
		expect(message.content.some((block) => block.type === "toolCall")).toBe(true);
		expect(message.stopReason, message.errorMessage).toBe("toolUse");
	});

	it("Responses: a refusal ends as an error, like a Completions content_filter", async () => {
		const refusal = "I can't help with that";
		const message = { type: "message", id: "m1", role: "assistant" };
		const events = [
			{ type: "response.created", response: { id: "r1", status: "in_progress" } },
			{ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
			{
				type: "response.content_part.added",
				item_id: "m1",
				output_index: 0,
				content_index: 0,
				part: { type: "refusal", refusal: "" },
			},
			{ type: "response.refusal.delta", item_id: "m1", output_index: 0, content_index: 0, delta: refusal },
			{ type: "response.refusal.done", item_id: "m1", output_index: 0, content_index: 0, refusal },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { ...message, status: "completed", content: [{ type: "refusal", refusal }] },
			},
			{
				type: "response.completed",
				response: {
					id: "r1",
					status: "completed",
					output: [],
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		];
		const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		const result = await streamResponses(responsesModel, context, {
			apiKey: "k",
			fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("content-filter");
	});
});
