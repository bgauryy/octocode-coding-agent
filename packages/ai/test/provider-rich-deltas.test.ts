import { completionsResponse } from "./completions-fetch-fixture.ts";
import { expect, it } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { bedrockModel, bedrockContext, bedrockResponse } from "./bedrock-fixtures.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import type { Api, Model } from "../src/types.ts";

function model<T extends Api>(api: T): Model<T> {
	return {
		api,
		provider: "fixture",
		id: "fixture",
		name: "Fixture",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 4096,
	};
}

it("retains Bedrock image chunks and citations without persisting byte scratch buffers", async () => {
	const output = await streamBedrock(bedrockModel, bedrockContext, {
		apiKey: "test",
		env: {},
		fetch: async () =>
			bedrockResponse([
				{ messageStart: { role: "assistant" } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Answer" } } },
				{
					contentBlockDelta: {
						contentBlockIndex: 0,
						delta: {
							citation: {
								title: "Document",
								source: "https://example.invalid/document",
								sourceContent: [{ text: "Source" }],
								location: { documentPage: { documentIndex: 0, start: 2, end: 3 } },
							},
						},
					},
				},
				{ contentBlockStop: { contentBlockIndex: 0 } },
				{ contentBlockStart: { contentBlockIndex: 1, start: { image: { format: "png" } } } },
				{ contentBlockDelta: { contentBlockIndex: 1, delta: { image: { source: { bytes: "AQI=" } } } } },
				{ contentBlockDelta: { contentBlockIndex: 1, delta: { image: { source: { bytes: "AwQ=" } } } } },
				{ messageStop: { stopReason: "end_turn" } },
			]),
	}).result();
	expect(output.stopReason).toBe("stop");
	expect(output.content).toEqual([
		{
			type: "text",
			text: "Answer",
			annotations: [
				{
					type: "citation",
					title: "Document",
					url: "https://example.invalid/document",
					text: "Source",
					documentIndex: 0,
					startPage: 2,
					endPage: 3,
				},
			],
		},
		{ type: "image", mimeType: "image/png", data: "AQIDBA==" },
	]);
});

async function mistralContent(content: unknown[], extra = {}) {
	return streamMistral(
		model("mistral-conversations"),
		normalizeContext({ messages: [{ role: "user", content: "generate", timestamp: 0 }] }),
		{
			apiKey: "fixture",
			fetch: async () =>
				new Response(
					`data: ${JSON.stringify({ ...extra, choices: [{ index: 0, finish_reason: "stop", delta: { content } }] })}\n\ndata: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				),
		},
	).result();
}

it("retains Mistral generated images through the SDK raw-part boundary", async () => {
	const output = await mistralContent([
		{ type: "text", text: "Image follows" },
		{ type: "image_url", image_url: { url: "data:image/png;base64,AQIDBA==", detail: null } },
	]);
	expect(output.errorMessage).toBeUndefined();
	expect(output.content).toEqual([
		{ type: "text", text: "Image follows" },
		{ type: "image", mimeType: "image/png", data: "AQIDBA==" },
	]);
});

it("keeps Mistral text and generated images in wire order within and across chunks", async () => {
	const image = { type: "image_url", image_url: { url: "data:image/png;base64,AQIDBA==", detail: null } };
	const chunks = [[{ type: "text", text: "A" }, image, { type: "text", text: "B" }], "C", [image], "D"];
	const body = chunks
		.map(
			(content, index) =>
				`data: ${JSON.stringify({ choices: [{ index: 0, finish_reason: index === chunks.length - 1 ? "stop" : null, delta: { content } }] })}\n\n`,
		)
		.join("");
	const events = streamMistral(
		model("mistral-conversations"),
		normalizeContext({ messages: [{ role: "user", content: "generate", timestamp: 0 }] }),
		{
			apiKey: "fixture",
			fetch: async () => new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }),
		},
	);
	const kinds: string[] = [];
	for await (const event of events) if (event.type.startsWith("text_")) kinds.push(event.type);
	const output = await events.result();
	const png = { type: "image", mimeType: "image/png", data: "AQIDBA==" };
	expect(output.errorMessage).toBeUndefined();
	expect(output.content).toEqual([
		{ type: "text", text: "A" },
		png,
		{ type: "text", text: "BC" },
		png,
		{ type: "text", text: "D" },
	]);
	// Each text block opens and closes once.
	expect(kinds.filter((kind) => kind === "text_start")).toHaveLength(3);
	expect(kinds.filter((kind) => kind === "text_end")).toHaveLength(3);
});

it("fails explicitly for Mistral content rejected by the SDK schema", async () => {
	const output = await mistralContent([{ type: "future_output", text: "A provider attachment" }]);
	expect(output.stopReason).toBe("error");
	expect(output.errorMessage).toContain("Mistral provider stream error");
});

it("accepts unknown extra fields on a normal Mistral reply", async () => {
	const output = await mistralContent([{ type: "text", text: "normal" }], { future_metadata: { value: true } });
	expect(output.stopReason).toBe("stop");
	expect(output.content).toEqual([{ type: "text", text: "normal" }]);
});

it("keeps a chat-completions refusal visible instead of producing an empty successful answer", async () => {
	const selected = model("openai-completions");
	const output = await streamCompletions(
		selected,
		normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] }),
		{
			apiKey: "fixture",
			fetch: async () =>
				completionsResponse([
					{ choices: [{ index: 0, delta: { refusal: "Cannot complete this request." }, finish_reason: "stop" }] },
				]),
		},
	).result();
	expect(output.content).toEqual([{ type: "text", text: "Cannot complete this request." }]);
});

it("updates a partial image in place and retains decoded audio chunk boundaries", async () => {
	const events = [
		{ type: "response.created", response: { id: "resp_rich" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "image_generation_call", id: "image", status: "in_progress", result: null },
		},
		{
			type: "response.image_generation_call.partial_image",
			item_id: "image",
			output_index: 0,
			partial_image_index: 0,
			sequence_number: 1,
			partial_image_b64: "AQI=",
			output_format: "png",
		},
		{ type: "response.audio.delta", sequence_number: 2, delta: "AQI=" },
		{ type: "response.audio.delta", sequence_number: 3, delta: "AwQ=" },
		{ type: "response.audio.transcript.delta", sequence_number: 4, delta: "Transcript" },
		{ type: "response.completed", response: { id: "resp_rich", status: "completed", output: [] } },
	];
	const output = await streamResponses(
		model("openai-responses"),
		normalizeContext({ messages: [{ role: "user", content: "generate", timestamp: 0 }] }),
		{
			apiKey: "sk-test",
			fetch: async () =>
				new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				}),
		},
	).result();
	expect(output.errorMessage).toBeUndefined();
	expect(output.content.slice(0, 1)).toEqual([{ type: "image", mimeType: "image/png", data: "AQI=" }]);
	expect(output.content.slice(1)).toEqual([
		{ type: "media", mimeType: "application/octet-stream", name: "Response audio", data: "AQIDBA==" },
		{ type: "text", text: "Transcript" },
	]);
});
