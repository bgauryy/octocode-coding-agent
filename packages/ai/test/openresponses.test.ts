import { describe, expect, it } from "vitest";
import { openResponsesApi } from "../src/api/openresponses.lazy.ts";
import { stream as streamOpenResponses, streamSimple as streamSimpleOpenResponses } from "../src/api/openresponses.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const base: Omit<Model<"openai-responses">, "api"> = {
	id: "local-model",
	name: "Local",
	provider: "local-open-responses",
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};
const model = { ...base, api: "openresponses" } as unknown as Model<"openresponses">;
const responsesModel = { ...base, api: "openai-responses" } as Model<"openai-responses">;
const context: TranscriptContext = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

const events = [
	{ type: "response.created", response: { id: "resp_1" } },
	{
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "message", id: "m1", role: "assistant", status: "in_progress", content: [] },
	},
	{
		type: "response.content_part.added",
		item_id: "m1",
		output_index: 0,
		content_index: 0,
		part: { type: "output_text", text: "", annotations: [] },
	},
	{ type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: "hello" },
	{
		type: "response.output_item.done",
		output_index: 0,
		item: {
			type: "message",
			id: "m1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "hello", annotations: [] }],
		},
	},
	{
		type: "response.completed",
		response: {
			id: "resp_1",
			status: "completed",
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } },
		},
	},
];

function capture() {
	const captured: { url?: string; body?: Record<string, unknown>; headers?: Headers } = {};
	const fetch: typeof globalThis.fetch = async (input, init) => {
		captured.url = String(input);
		captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		captured.headers = new Headers(init?.headers);
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	return { captured, fetch };
}

describe("OpenResponses API", () => {
	it("sends the same /responses request as the OpenAI Responses transport", async () => {
		const open = capture();
		const reference = capture();
		await streamOpenResponses(model, context, { apiKey: "k", fetch: open.fetch }).result();
		await streamOpenAIResponses(responsesModel, context, { apiKey: "k", fetch: reference.fetch }).result();
		expect(open.captured.url).toBe("http://127.0.0.1:9/v1/responses");
		expect(open.captured.body).toEqual(reference.captured.body);
		expect(open.captured.headers?.get("authorization")).toBe("Bearer k");
	});

	it("streams the contract's events, usage and cost, labelled with its own API", async () => {
		const { fetch } = capture();
		const seen: string[] = [];
		const stream = streamOpenResponses(model, context, { apiKey: "k", fetch });
		for await (const event of stream) {
			seen.push(event.type);
			const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
			expect(message.api).toBe("openresponses");
		}
		const message = await stream.result();
		expect(seen[0]).toBe("start");
		expect(seen).toContain("text_delta");
		expect(seen.at(-1)).toBe("done");
		expect(message).toMatchObject({ api: "openresponses", stopReason: "stop", responseId: "resp_1" });
		expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "hello" })]);
		expect(message.usage).toMatchObject({ input: 10, output: 5, totalTokens: 15 });
		expect(message.usage.cost.total).toBeCloseTo(0.00002, 10);
	});

	it("reports a failing endpoint as an error event on its own API", async () => {
		const fetch: typeof globalThis.fetch = async () => new Response('{"error":{"message":"bad"}}', { status: 400 });
		const message = await streamOpenResponses(model, context, { apiKey: "k", fetch, maxRetries: 0 }).result();
		expect(message).toMatchObject({ api: "openresponses", stopReason: "error" });
	});

	it("serves the simple entry point with a reasoning level", async () => {
		const { captured, fetch } = capture();
		const reasoning = { ...model, reasoning: true } as Model<"openresponses">;
		const message = await streamSimpleOpenResponses(reasoning, context, {
			apiKey: "k",
			fetch,
			reasoning: "low",
		}).result();
		expect(message.stopReason).toBe("stop");
		expect(captured.body?.reasoning).toBeDefined();
	});

	it("loads lazily and exposes both stream functions", async () => {
		const api = openResponsesApi();
		expect(typeof api.stream).toBe("function");
		expect(typeof api.streamSimple).toBe("function");
		const { fetch } = capture();
		const message = await api.stream(model, context, { apiKey: "k", fetch }).result();
		expect(message.api).toBe("openresponses");
	});
});
