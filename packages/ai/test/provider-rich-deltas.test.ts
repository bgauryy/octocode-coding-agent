import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { expect, it } from "vitest";
import {
	handleContentBlockDelta,
	handleContentBlockStart,
	handleContentBlockStop,
	finalizeStreamingBlock,
} from "../src/api/bedrock-converse-stream/stream-events.ts";
import type { Block } from "../src/api/bedrock-converse-stream/types.ts";
import { consumeChatStream } from "../src/api/mistral-conversations/stream-events.ts";
import { createCompletionsChunkProcessor } from "../src/api/openai-completions/stream-events.ts";
import { ResponsesArtifacts } from "../src/api/openai-responses-shared/stream-artifacts.ts";
import type { Api, Model } from "../src/types.ts";
import { createPendingAssistantMessage } from "../src/utils/assistant-message.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

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

it("retains Bedrock image chunks and citations without persisting byte scratch buffers", () => {
	const output = createPendingAssistantMessage(model("bedrock-converse-stream"));
	const blocks = output.content as Block[];
	const stream = new AssistantMessageEventStream();
	handleContentBlockDelta({ contentBlockIndex: 0, delta: { text: "Answer" } }, blocks, output, stream);
	handleContentBlockDelta(
		{
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
		blocks,
		output,
		stream,
	);
	handleContentBlockStop({ contentBlockIndex: 0 }, blocks, output, stream);
	handleContentBlockStart({ contentBlockIndex: 1, start: { image: { format: "png" } } }, blocks, output, stream);
	handleContentBlockDelta(
		{ contentBlockIndex: 1, delta: { image: { source: { bytes: new Uint8Array([1, 2]) } } } },
		blocks,
		output,
		stream,
	);
	handleContentBlockDelta(
		{ contentBlockIndex: 1, delta: { image: { source: { bytes: new Uint8Array([3, 4]) } } } },
		blocks,
		output,
		stream,
	);
	for (const block of blocks) finalizeStreamingBlock(block);
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

it("retains Mistral image parts and makes unknown parts explicit", async () => {
	const selected = model("mistral-conversations");
	const output = createPendingAssistantMessage(selected);
	await consumeChatStream(
		selected,
		output,
		new AssistantMessageEventStream(),
		(async function* () {
			yield {
				data: {
					choices: [
						{
							finish_reason: "stop",
							delta: {
								content: [
									{ type: "text", text: "Image follows" },
									{ type: "image_url", image_url: { url: "data:image/png;base64,AQIDBA==" } },
									{ type: "future_output", text: "A provider attachment" },
								],
							},
						},
					],
				},
			};
		})(),
		undefined,
	);
	expect(output.content).toEqual([
		{ type: "text", text: "Image follows" },
		{ type: "image", mimeType: "image/png", data: "AQIDBA==" },
		{ type: "unsupported", providerType: "future_output", text: "A provider attachment" },
	]);
});

it("keeps a chat-completions refusal visible instead of producing an empty successful answer", () => {
	const selected = model("openai-completions");
	const output = createPendingAssistantMessage(selected);
	const processor = createCompletionsChunkProcessor(selected, output, new AssistantMessageEventStream(), new Map(), {
		details: [],
	});
	processor.processChunk({
		choices: [{ index: 0, delta: { refusal: "Cannot complete this request." }, finish_reason: "stop", logprobs: null }],
	} as ChatCompletionChunk);
	processor.finishBlocks();
	expect(output.content).toEqual([{ type: "text", text: "Cannot complete this request." }]);
});

it("updates a partial image in place and retains decoded audio chunk boundaries", () => {
	const output = createPendingAssistantMessage(model("openai-responses"));
	const artifacts = new ResponsesArtifacts(output, new AssistantMessageEventStream());
	artifacts.upsert({ type: "image_generation_call", id: "image", status: "in_progress", result: null }, 0);
	artifacts.accept({
		type: "response.image_generation_call.partial_image",
		item_id: "image",
		output_index: 0,
		partial_image_index: 0,
		sequence_number: 1,
		partial_image_b64: "AQI=",
		output_format: "png",
	});
	expect(output.content).toEqual([{ type: "image", mimeType: "image/png", data: "AQI=" }]);
	artifacts.accept({ type: "response.audio.delta", sequence_number: 2, delta: "AQI=" });
	artifacts.accept({ type: "response.audio.delta", sequence_number: 3, delta: "AwQ=" });
	artifacts.accept({ type: "response.audio.transcript.delta", sequence_number: 4, delta: "Transcript" });
	expect(output.content.slice(1)).toEqual([
		{ type: "media", mimeType: "application/octet-stream", name: "Response audio", data: "AQIDBA==" },
		{ type: "text", text: "Transcript" },
	]);
});
