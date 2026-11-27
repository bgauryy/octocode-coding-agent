import { describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { normalizeContext } from "../src/compat.ts";
import type { Model } from "../src/types.ts";
import { completionsResponse, mockCompletionsFetch } from "./completions-fetch-fixture.ts";

const text = { id: "c1", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] };
const stop = { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
const usage = { id: "c1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
let chunks: unknown[] = [];

mockCompletionsFetch(() => completionsResponse(chunks));

const model: Model<"openai-completions"> = {
	id: "local-model",
	name: "Local model",
	api: "openai-completions",
	provider: "local",
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

async function finalUsage() {
	const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
	const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();
	expect(message.stopReason).toBe("stop");
	return message.usage;
}

describe("Chat Completions usage at the end of a stream", () => {
	it("marks a finished stream that never reported usage as a lower bound", async () => {
		chunks = [text, stop];
		const result = await finalUsage();
		expect(result.totalTokens).toBe(0);
		expect(result.lowerBound).toBe(true);
	});

	it("keeps a reported count complete", async () => {
		chunks = [text, stop, usage];
		const result = await finalUsage();
		expect(result.output).toBe(5);
		expect(result.lowerBound).toBeUndefined();
	});
});
