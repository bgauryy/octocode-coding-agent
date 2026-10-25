import { describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-completions.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";
import { assertImageRequestContext, assertImageRequestPayload } from "../src/utils/image-input.ts";
import { createPendingAssistantMessage } from "../src/utils/assistant-message.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { createModels } from "../src/models.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/providers/faux.ts";

const model: Model<"openai-completions"> = {
	id: "fixture",
	name: "Fixture",
	provider: "fixture",
	api: "openai-completions",
	baseUrl: "https://example.invalid/v1",
	input: ["text", "image"],
	reasoning: false,
	contextWindow: 4096,
	maxTokens: 512,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const image = { type: "image" as const, mimeType: "image/png", data: "ZmFrZQ==" };
const user: Message = { role: "user", content: [image], timestamp: 1 };
const textOnly = { ...model, input: ["text"] as ("text" | "image")[] };
const answered: AssistantMessage = {
	...createPendingAssistantMessage(model),
	content: [{ type: "text", text: "seen" }],
	stopReason: "stop",
};

describe("image input validation", () => {
	it.each(["stream", "streamSimple"] as const)("guards custom provider calls through Models.%s", async (method) => {
		const faux = fauxProvider({ models: [{ id: "text-only", input: ["text"] }] });
		faux.setResponses([fauxAssistantMessage("unused")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const result = await models[method](faux.models[0], { messages: [user] }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("accept images");
		expect(faux.getPendingResponseCount()).toBe(1);
	});

	it("rejects new images for text-only models without mutating the input", () => {
		expect(() => transformMessages([user], textOnly)).toThrow("not configured to accept images");
		expect(user.content).toEqual([image]);
		expect(transformMessages([user], model)[0].content).toEqual([image]);
	});

	it("downgrades historical images after switching to a text-only model", () => {
		const messages: Message[] = [user, answered, { role: "user", content: "Continue with text", timestamp: 3 }];
		expect(transformMessages(messages, textOnly)[0].content).toEqual([
			{ type: "text", text: "(image omitted: model does not support images)" },
		]);
		expect(user.content).toEqual([image]);
	});

	it.each(["error", "aborted"] as const)("rechecks unprocessed images after a %s response", (stopReason) => {
		expect(() => assertImageRequestContext(textOnly, [user, { ...answered, stopReason }])).toThrow("accept images");
	});

	it("counts history and tool images toward the full request", () => {
		const limited = { ...model, inputLimits: { images: { maxPerRequest: 1 } } };
		const tool: Message = {
			role: "toolResult",
			toolName: "screenshot",
			toolCallId: "call",
			content: [image],
			isError: false,
			timestamp: 4,
		};
		expect(() => assertImageRequestContext(limited, [user, answered, tool])).toThrow("contains 2");
	});

	it.each([
		{
			messages: [
				{
					content: [
						{ type: "tool_result", content: [image] },
						{ type: "tool_result", content: [image] },
					],
				},
			],
		},
		{
			messages: [
				{
					content: [{ toolResult: { content: [{ image: { source: { bytes: new Uint8Array(3) } } }] } }, { image: {} }],
				},
			],
		},
		{
			input: [
				{
					type: "function_call_output",
					output: [
						{ type: "input_image", image_url: "data:image/png;base64,abc" },
						{ type: "input_image", image_url: "data:image/png;base64,abc" },
					],
				},
			],
		},
		{
			contents: [
				{
					parts: [
						{ inlineData: { mimeType: "image/png", data: "abc" } },
						{ functionResponse: { parts: [{ inlineData: { mimeType: "image/png", data: "abc" } }] } },
					],
				},
			],
		},
	])("checks image limits after provider message grouping: %j", (payload) => {
		expect(() =>
			assertImageRequestPayload({ ...model, inputLimits: { images: { maxPerMessage: 1 } } }, payload),
		).toThrow("per message");
	});

	it("does not count quoted images, schemas or tool JSON as image attachments", () => {
		const payload = {
			messages: [
				{ content: [{ type: "text", text: JSON.stringify(image) }, { toolResult: { content: [{ json: image }] } }] },
			],
			tools: [{ schema: image }],
		};
		expect(() => assertImageRequestPayload(textOnly, payload)).not.toThrow();
	});

	it("measures UTF-8 bytes and includes tool schemas in the request budget", () => {
		const payload = { messages: [], tools: [{ description: "אבג" }] };
		const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
		expect(() =>
			assertImageRequestPayload({ ...model, inputLimits: { maxRequestBytes: bytes } }, payload),
		).not.toThrow();
		expect(() => assertImageRequestPayload({ ...model, inputLimits: { maxRequestBytes: bytes - 1 } }, payload)).toThrow(
			`${bytes} bytes`,
		);
	});

	it("accounts for Bedrock binary sources as base64", () => {
		const payload = { messages: [{ content: [{ image: { source: { bytes: new Uint8Array(4) } } }] }] };
		const encoded = { messages: [{ content: [{ image: { source: { bytes: "AAAAAA==" } } }] }] };
		const bytes = new TextEncoder().encode(JSON.stringify(encoded)).length;
		expect(() =>
			assertImageRequestPayload({ ...model, inputLimits: { maxRequestBytes: bytes } }, payload),
		).not.toThrow();
		expect(() => assertImageRequestPayload({ ...model, inputLimits: { maxRequestBytes: bytes - 1 } }, payload)).toThrow(
			"payload",
		);
	});

	it("validates onPayload replacements before any network request", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw new Error("Unexpected network request");
		});
		const result = await stream(
			{ ...model, inputLimits: { images: { maxPerRequest: 1 } } },
			normalizeContext({ messages: [user] }),
			{
				apiKey: "fake",
				fetch,
				onPayload: () => ({ messages: [{ role: "user", content: [image, image] }] }),
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("contains 2");
		expect(fetch).not.toHaveBeenCalled();
	});
});
