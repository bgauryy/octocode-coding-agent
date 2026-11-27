import { describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/google-generative-ai.ts";
import { sdkMessages } from "../src/api/ai-sdk/messages.ts";
import { prepareSdkRequest } from "../src/api/ai-sdk/transport.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { createPendingAssistantMessage } from "../src/utils/assistant-message.ts";
import type { AssistantContent } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model = getBuiltinModel("google", "gemini-2.5-flash");

describe("Gemini SDK migration", () => {
	it("replays a resource URI without downloading or uploading it", async () => {
		const assistant = {
			...createPendingAssistantMessage(model),
			content: [{ type: "resource" as const, uri: "gs://bucket/video", mimeType: "video/mp4" }],
			stopReason: "stop" as const,
		};
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					`data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const result = await stream(
			model,
			normalizeContext({ messages: [assistant, { role: "user", content: "continue", timestamp: 0 }] }),
			{ apiKey: "test", fetch },
		).result();
		expect(result.errorMessage).toBeUndefined();
		expect(fetch).toHaveBeenCalledOnce();
		const payload = JSON.parse(fetch.mock.calls[0][1]!.body as string);
		expect(payload.contents[0].parts[0]).toMatchObject({
			fileData: { fileUri: "gs://bucket/video", mimeType: "video/mp4" },
		});
	});
	it.each([
		[{ inlineData: { mimeType: "image/png", data: "aW1n" } }, { type: "image", mimeType: "image/png", data: "aW1n" }],
		[
			{ inlineData: { mimeType: "audio/wav", data: "YXVkaW8=" } },
			{ type: "media", mimeType: "audio/wav", data: "YXVkaW8=" },
		],
		[
			{ fileData: { mimeType: "video/mp4", fileUri: "gs://bucket/video" } },
			{ type: "resource", mimeType: "video/mp4", uri: "gs://bucket/video" },
		],
	])("preserves provider attachment %j", async (part, expected) => {
		const event = { candidates: [{ index: 0, content: { role: "model", parts: [part] }, finishReason: "STOP" }] };
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
		);
		const result = await stream(
			model,
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
			{ apiKey: "test", fetch },
		).result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toContainEqual(expected);
		expect(fetch).toHaveBeenCalledOnce();
	});
	it.each<AssistantContent>([
		{ type: "image", mimeType: "image/png", data: "aW1n" },
		{ type: "media", mimeType: "audio/wav", data: "YXVkaW8=" },
		{ type: "resource", mimeType: "video/mp4", uri: "https://generativelanguage.googleapis.com/v1beta/files/video" },
	])("replays assistant $type as an SDK file", (block) => {
		const assistant = { ...createPendingAssistantMessage(model), content: [block], stopReason: "stop" as const };
		const messages = sdkMessages(model, normalizeContext({ messages: [assistant] }));
		expect(messages[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "file", mediaType: "mimeType" in block ? block.mimeType : undefined }],
		});
	});
	it("inspects, mutates and replaces the SDK wire JSON", async () => {
		const init = { body: JSON.stringify({ contents: [] }), method: "POST" };
		const mutated = await prepareSdkRequest(
			model,
			{
				onPayload: (body) => {
					(body as Record<string, unknown>).temperature = 1;
				},
			},
			"https://example.test",
			init,
		);
		expect(JSON.parse(mutated!.body as string)).toEqual({ contents: [], temperature: 1 });
		const replaced = await prepareSdkRequest(
			model,
			{ onPayload: async () => ({ replaced: true }) },
			"https://example.test",
			init,
		);
		expect(JSON.parse(replaced!.body as string)).toEqual({ replaced: true });
	});

	it.each(["google-generative-ai", "anthropic-messages", "openai-completions"] as const)(
		"keeps tool-result image bytes for %s",
		(api) => {
			const messages = sdkMessages(
				{ ...model, api },
				normalizeContext({
					messages: [
						{
							role: "toolResult",
							toolCallId: "call",
							toolName: "inspect",
							content: [
								{ type: "text", text: "screen" },
								{ type: "image", mimeType: "image/png", data: "aW1n" },
							],
							isError: false,
							timestamp: 0,
						},
					],
				}),
			);
			expect(messages[0]).toMatchObject({
				role: "tool",
				content: [
					{
						output: {
							type: "content",
							value: [
								{ type: "text", text: "screen" },
								{ type: "file", mediaType: "image/png", data: { type: "data", data: "aW1n" } },
							],
						},
					},
				],
			});
		},
	);

	it("does not follow a provider continuation token or hide its raw event", async () => {
		const event = {
			candidates: [
				{
					index: 0,
					content: { role: "model", parts: [{ text: "partial" }] },
					finishReason: "CONTINUATION",
					continuationToken: "paid-next-hop",
				},
			],
		};
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
		);
		const observer = vi.fn();
		await stream(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {
			apiKey: "test",
			fetch,
			onProviderStreamEvent: observer,
		}).result();
		expect(fetch).toHaveBeenCalledOnce();
		expect(observer).toHaveBeenCalledOnce();
		expect(observer).toHaveBeenCalledWith(event, model);
	});
});
