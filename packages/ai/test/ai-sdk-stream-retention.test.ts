import { describe, expect, it } from "vitest";
import { stream as completions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	id: "test-model",
	name: "Test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};
const context = normalizeContext({ systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 0 }] });

const CHUNKS = 40_000;
/** Bytes each chunk carries beside its one-letter delta: kept alive, the chunks would hold about 160 MB. */
const PAD = "p".repeat(4_000);

/** An SSE body produced on demand, sampling the heap as it goes: the peak is what the reader kept alive. */
function longReply(samples: number[]): Response {
	const encoder = new TextEncoder();
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent === CHUNKS) {
				const end = {
					id: "r",
					object: "chat.completion.chunk",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				};
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`));
				controller.close();
				return;
			}
			if (sent % 2_000 === 0) samples.push(process.memoryUsage().heapUsed);
			const chunk = {
				id: "r",
				object: "chat.completion.chunk",
				pad: PAD,
				choices: [{ index: 0, delta: { content: "a" } }],
			};
			controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
			sent++;
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("a long streamed reply", () => {
	it("does not keep each provider chunk alive until the reply ends", async () => {
		const samples: number[] = [];
		const start = process.memoryUsage().heapUsed;
		const result = await completions(model, context, {
			apiKey: "test-key",
			fetch: async () => longReply(samples),
		}).result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "a".repeat(CHUNKS) }]);
		// Kept chunks grow the heap by their whole size (about 160 MB); a streaming reader holds a bounded window.
		const peakGrowthMB = (Math.max(...samples) - start) / 1_048_576;
		expect(peakGrowthMB).toBeLessThan(80);
	}, 120_000);
});
