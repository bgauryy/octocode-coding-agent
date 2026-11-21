import { describe, expect, it, vi } from "vitest";
import { stream as googleStream } from "../src/api/google-generative-ai.ts";
import { stream as vertexStream } from "../src/api/google-vertex.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model = getBuiltinModel("google", "gemini-2.5-flash");
const vertex = getBuiltinModel("google-vertex", "gemini-3-flash-preview");
const context = normalizeContext({ messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] });
const encode = (chunk: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
const candidate = (parts: unknown[], finishReason?: string) => ({
	candidates: [{ index: 0, content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }],
});
const response = (chunks: unknown[]) =>
	new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encode(chunk));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);

describe("Google public SDK regressions", () => {
	it("replays a generated Vertex image on the next turn", async () => {
		const image = { inlineData: { mimeType: "image/png", data: "aW1n" }, thoughtSignature: "signed-image" };
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(response([candidate([image], "STOP")]))
			.mockResolvedValueOnce(response([candidate([{ text: "ok" }], "STOP")]));
		const first = await vertexStream(vertex, context, { apiKey: "test", fetch }).result();
		expect(first.errorMessage).toBeUndefined();
		expect(first.content).toContainEqual({
			type: "image",
			mimeType: "image/png",
			data: "aW1n",
			thoughtSignature: "signed-image",
		});
		const second = await vertexStream(
			vertex,
			normalizeContext({ messages: [...context.messages, first, { role: "user", content: "continue", timestamp: 0 }] }),
			{ apiKey: "test", fetch },
		).result();
		expect(second.errorMessage).toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(2);
		const body = JSON.parse(fetch.mock.calls[1][1]!.body as string);
		expect(body.contents[1].parts).toContainEqual(image);
	});

	it("replays a Vertex URI artifact as a fileData part at its position", async () => {
		const file = { fileData: { fileUri: "gs://bucket/video", mimeType: "video/mp4" }, thoughtSignature: "signed-file" };
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(response([candidate([{ text: "before" }, file, { text: "after" }], "STOP")]))
			.mockResolvedValueOnce(response([candidate([{ text: "ok" }], "STOP")]));
		const first = await vertexStream(vertex, context, { apiKey: "test", fetch }).result();
		expect(first.errorMessage).toBeUndefined();
		expect(first.content).toContainEqual({
			type: "resource",
			uri: "gs://bucket/video",
			mimeType: "video/mp4",
			thoughtSignature: "signed-file",
		});
		const second = await vertexStream(
			vertex,
			normalizeContext({ messages: [...context.messages, first, { role: "user", content: "continue", timestamp: 0 }] }),
			{ apiKey: "test", fetch },
		).result();
		expect(second.errorMessage).toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(2);
		const body = JSON.parse(fetch.mock.calls[1][1]!.body as string);
		const parts = body.contents[1].parts as Record<string, unknown>[];
		expect(parts.map((part) => part.text ?? part.fileData)).toEqual(["before", file.fileData, "after"]);
		expect(parts[1]).toEqual(file);
		expect(JSON.stringify(body)).not.toContain("octocode-vertex-file");
	});

	it.each(["error", "abort"] as const)("keeps priced reported usage after reader %s", async (failure) => {
		const abort = new AbortController();
		let reader: ReadableStreamDefaultController<Uint8Array>;
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							reader = controller;
							controller.enqueue(
								encode({
									...candidate([{ text: "hello" }]),
									usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 },
								}),
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const events = googleStream(model, context, { apiKey: "test", fetch, signal: abort.signal });
		for await (const event of events) {
			if (event.type === "text_delta") {
				if (failure === "abort") abort.abort();
				else reader!.error(new Error("reader failed"));
			}
		}
		const result = await events.result();
		expect(result.stopReason).toBe(failure === "abort" ? "aborted" : "error");
		expect(result.usage).toMatchObject({ input: 100, output: 10, totalTokens: 110, lowerBound: true });
		expect(result.usage.cost.total).toBeGreaterThan(0);
	});

	it("releases one logical tool barrier after several raw argument fragments", async () => {
		const chunks = [
			candidate([
				{
					functionCall: {
						id: "call-1",
						name: "echo",
						willContinue: true,
						partialArgs: [{ jsonPath: "$.value", stringValue: "hel", willContinue: true }],
					},
				},
			]),
			candidate([{ functionCall: { partialArgs: [{ jsonPath: "$.value", stringValue: "lo", willContinue: true }] } }]),
			candidate([{ functionCall: {} }]),
			candidate([{ text: "after" }, { inlineData: { mimeType: "image/png", data: "aW1n" } }, { text: "end" }], "STOP"),
		];
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response(chunks));
		const events = googleStream(model, context, { apiKey: "test", fetch });
		const deltas: string[] = [];
		for await (const event of events) if (event.type === "text_delta") deltas.push(event.delta);
		const result = await events.result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([
			expect.objectContaining({ type: "toolCall", name: "echo", arguments: { value: "hello" } }),
			{ type: "text", text: "after" },
			{ type: "image", mimeType: "image/png", data: "aW1n" },
			{ type: "text", text: "end" },
		]);
		expect(deltas).toEqual(["after", "end"]);
	});

	it.each(["google", "vertex"] as const)("awaits and forwards every raw %s event exactly once", async (provider) => {
		const chunks = [candidate([{ text: "hello" }]), candidate([{ text: "world" }], "STOP")];
		const received: unknown[] = [];
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response(chunks));
		const options = {
			apiKey: "test",
			fetch,
			onProviderStreamEvent: async (chunk: unknown) => {
				await Promise.resolve();
				received.push(chunk);
			},
		};
		const result = await (
			provider === "google" ? googleStream(model, context, options) : vertexStream(vertex, context, options)
		).result();
		expect(result.errorMessage).toBeUndefined();
		expect(received).toEqual(chunks);
	});
});
