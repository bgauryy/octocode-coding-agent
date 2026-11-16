import { describe, expect, it } from "vitest";
import { stream } from "../src/api/google-generative-ai.ts";
interface Part {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
}
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
	const frames = [
		...chunks.map((parts) => ({ candidates: [{ index: 0, content: { role: "model", parts } }] })),
		{ candidates: [{ index: 0, finishReason: "STOP" }] },
	];
	const events = stream(model, context, {
		apiKey: "test-key",
		fetch: async () =>
			new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			}),
	});
	const deltas: string[] = [];
	for await (const event of events) {
		if (event.type === "text_delta" || event.type === "thinking_delta") deltas.push(event.delta);
	}
	const result = await events.result();
	expect(deltas.join("")).toBe(
		chunks
			.flat()
			.map((part) => part.text ?? "")
			.join(""),
	);
	expect(result.stopReason).toBe("stop");
	let contents: { parts?: Part[] }[] | undefined;
	const replayed = await stream(model, normalizeContext({ messages: [result] }), {
		apiKey: "test-key",
		onPayload: (payload) => {
			contents = (payload as { contents: { parts?: Part[] }[] }).contents;
			throw new Error("request captured");
		},
	}).result();
	expect(replayed.errorMessage).toBe("request captured");
	return contents?.[0].parts;
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
