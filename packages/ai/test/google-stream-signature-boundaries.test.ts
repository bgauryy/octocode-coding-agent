import type { GenerateContentResponse, GoogleGenAI, Part } from "@google/genai";
import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/google-shared/messages.ts";
import { streamGoogle } from "../src/api/google-shared/stream.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"google-generative-ai"> = {
	id: "gemini-3-flash-preview",
	name: "Gemini",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};
const context = normalizeContext({
	messages: [{ role: "user", content: "Hello", timestamp: 0 }],
});
async function replay(chunks: Part[][]) {
	const client = {
		models: {
			generateContentStream: async function* () {
				for (const parts of chunks)
					yield {
						candidates: [{ content: { parts } }],
					} as GenerateContentResponse;
				yield {
					candidates: [{ finishReason: "STOP" }],
				} as GenerateContentResponse;
			},
		},
	} as unknown as GoogleGenAI;
	const events = streamGoogle(
		model,
		context,
		{},
		{
			name: "test",
			streamName: "test",
			prepare: () => ({ client, params: { model: model.id, contents: [] } }),
		},
	);
	const result = await events.result();
	expect(result.stopReason).toBe("stop");
	return convertMessages(model, normalizeContext({ messages: [result] }))[0].parts;
}

describe("Google streaming thought signature boundaries", () => {
	it.each([false, true])("preserves distinct signed parts, thinking=%s", async (thought) => {
		const parts = [
			{ text: "first", thought, thoughtSignature: "c2lnMQ==" },
			{ text: "second", thought, thoughtSignature: "c2lnMg==" },
		];
		const expected = parts.map(({ thought: isThought, ...part }) => ({
			...part,
			...(isThought ? { thought: true } : {}),
		}));
		expect(await replay([parts])).toEqual(expected);
		expect(await replay(parts.map((part) => [part]))).toEqual(expected);
	});

	it("preserves signed and unsigned parts within one chunk", async () => {
		const parts = [{ text: "first", thoughtSignature: "c2lnMQ==" }, { text: "second" }];
		expect(await replay([parts])).toEqual(parts);
	});

	it("keeps unsigned continuation deltas attached to their signed block", async () => {
		expect(await replay([[{ text: "first", thoughtSignature: "c2lnMQ==" }], [{ text: "second" }]])).toEqual([
			{ text: "firstsecond", thoughtSignature: "c2lnMQ==" },
		]);
	});

	it.each(["", undefined])("preserves signature-only endings with text=%s", async (text) => {
		expect(await replay([[{ text: "answer" }], [{ text, thoughtSignature: "c2lnMQ==" }]])).toEqual([
			{ text: "answer" },
			{ text: "", thoughtSignature: "c2lnMQ==" },
		]);
	});
});
