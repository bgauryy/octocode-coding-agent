import type { ResponseOutputItem, ResponseStreamEvent } from "../src/api/ai-sdk/openai-wire-types.ts";
import { describe, expect, it } from "vitest";
import { anthropicFrames } from "./anthropic-fetch-fixture.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared/stream-processing.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { Api, AssistantMessageEvent, Model } from "../src/types.ts";
import { createPendingAssistantMessage } from "../src/utils/assistant-message.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function model<T extends Api>(api: T, provider: string): Model<T> {
	return {
		api,
		provider,
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

async function responses(items: ResponseOutputItem[], terminalOnly = false) {
	const selected = model("openai-responses", "openai");
	const output = createPendingAssistantMessage(selected);
	const stream = new AssistantMessageEventStream();
	const frames: AssistantMessageEvent[] = [];
	const reading = (async () => {
		for await (const frame of stream) frames.push(frame);
	})();
	async function* events(): AsyncIterable<ResponseStreamEvent> {
		if (!terminalOnly)
			for (const [output_index, item] of items.entries()) {
				yield { type: "response.output_item.added", output_index, item };
				yield { type: "response.output_item.done", output_index, item };
			}
		yield {
			type: "response.completed",
			response: { id: "response", status: "completed", output: items },
		};
	}
	await processResponsesStream(events(), output, stream, selected);
	stream.end(output);
	await reading;
	return { output, frames };
}

describe("provider rich output", () => {
	it("preserves ordered OpenAI citations, generated images, and native search output", async () => {
		const { output, frames } = await responses([
			{
				type: "message",
				id: "m1",
				role: "assistant",
				status: "completed",
				content: [
					{ type: "output_text", text: "Prefix ", annotations: [] },
					{
						type: "output_text",
						text: "source",
						annotations: [
							{
								type: "url_citation",
								url: "https://example.invalid/source",
								title: "Source",
								start_index: 0,
								end_index: 6,
							},
						],
					},
				],
			},
			{ type: "image_generation_call", id: "image1", result: "aW1hZ2U=", output_format: "webp", status: "completed" },
			{ type: "web_search_call", id: "search1", status: "completed", action: { type: "search", query: "source" } },
		]);
		expect(output.content).toMatchObject([
			{
				type: "text",
				text: "Prefix source",
				annotations: [{ url: "https://example.invalid/source", startIndex: 7, endIndex: 13 }],
			},
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/webp" },
			{ type: "text", text: expect.stringContaining('"query": "source"') },
		]);
		expect(frames.some((frame) => frame.type === "content_update" && frame.contentIndex === 1)).toBe(true);
		expect(JSON.parse(JSON.stringify(output)).content).toEqual(output.content);
	});

	it("retains image results supplied only in the terminal OpenAI response", async () => {
		const { output } = await responses(
			[{ type: "image_generation_call", id: "image2", result: "cG5n", status: "completed" }],
			true,
		);
		expect(output.content).toEqual([{ type: "image", data: "cG5n", mimeType: "image/png" }]);
	});

	it("retains Gemini media, references, citations, and image replay signatures", async () => {
		const selected = model("google-generative-ai", "google");
		const chunks = [
			{
				candidates: [
					{
						content: {
							parts: [
								{ text: "Answer" },
								{ inlineData: { data: "aW1hZ2U=", mimeType: "image/png" }, thoughtSignature: "c2ln" },
								{ inlineData: { data: "YXVkaW8=", mimeType: "audio/wav" } },
								{ fileData: { fileUri: "gs://fixture/video", mimeType: "video/mp4" } },
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						finishReason: "STOP",
						groundingMetadata: {
							groundingChunks: [{ web: { uri: "https://example.invalid/source", title: "Source" } }],
							groundingSupports: [
								{ groundingChunkIndices: [0], segment: { startIndex: 0, endIndex: 6, text: "Answer" } },
							],
						},
					},
				],
			},
		];
		const stream = streamGoogle(
			selected,
			normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] }),
			{
				apiKey: "test-key",
				fetch: async () =>
					new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
						headers: { "content-type": "text/event-stream" },
					}),
			},
		);
		const mediaUpdates: number[] = [];
		for await (const event of stream) {
			if (
				event.type === "content_update" &&
				["image", "media"].includes(event.partial.content[event.contentIndex].type)
			)
				mediaUpdates.push(event.contentIndex);
		}
		const output = await stream.result();
		expect(mediaUpdates).toEqual([1, 2]);
		expect(output.stopReason, output.errorMessage).toBe("stop");
		expect(output.content).toMatchObject([
			{
				type: "text",
				text: "Answer",
				annotations: [{ type: "grounding", url: "https://example.invalid/source", text: "Answer" }],
			},
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png", thoughtSignature: "c2ln" },
			{ type: "media", data: "YXVkaW8=", mimeType: "audio/wav" },
			{ type: "resource", uri: "gs://fixture/video", mimeType: "video/mp4" },
		]);
		let replay: { parts?: unknown[] }[] = [];
		const captured = await streamGoogle(selected, normalizeContext({ messages: [output] }), {
			apiKey: "test-key",
			onPayload: (payload) => {
				replay = (payload as { contents: { parts?: unknown[] }[] }).contents;
				throw new Error("request captured");
			},
		}).result();
		expect(captured.errorMessage).toBe("request captured");
		expect(replay[0].parts).toContainEqual({
			inlineData: { data: "aW1hZ2U=", mimeType: "image/png" },
			thoughtSignature: "c2ln",
		});
		const foreign = transformMessages([output], model("openai-responses", "openai"))[0];
		expect(foreign.content).toMatchObject([
			{ type: "text" },
			{ type: "text", text: "[Assistant generated image: image/png]" },
			{ type: "text" },
			{ type: "text" },
		]);
		expect(JSON.stringify(foreign)).not.toContain("c2ln");
	});

	it("preserves Anthropic citation deltas and uploaded file identifiers", async () => {
		const selected = model("anthropic-messages", "anthropic");
		const events = [
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Document answer" } },
			{
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "citations_delta",
					citation: {
						type: "page_location",
						cited_text: "Source",
						document_index: 0,
						document_title: "Document",
						file_id: "file1",
						start_page_number: 2,
						end_page_number: 3,
					},
				},
			},
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "container_upload", file_id: "file2" } },
			{ type: "content_block_stop", index: 1 },
		];
		const output = await anthropicFrames(selected, events).result();
		expect(output.stopReason, output.errorMessage).toBe("stop");
		expect(output.content).toEqual([
			{
				type: "text",
				text: "Document answer",
				annotations: [
					{
						type: "page_location",
						text: "Source",
						title: "Document",
						fileId: "file1",
						documentIndex: 0,
						startPage: 2,
						endPage: 3,
					},
				],
			},
			{ type: "text", text: expect.stringContaining('"file_id": "file2"') },
		]);
	});
});
