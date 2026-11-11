import { describe, expect, it } from "vitest";
import { assertStreamCompleted, stripStreamScratch } from "../src/api/stream-finalize.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { createPendingAssistantMessage } from "../src/utils/assistant-message.ts";

const model: Model<"openai-responses"> = {
	id: "m",
	name: "m",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

function message(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return { ...createPendingAssistantMessage(model), stopReason, errorMessage };
}

describe("assertStreamCompleted", () => {
	it("names the provider and its term when the stream ends without a stop", () => {
		expect(() => assertStreamCompleted(message("pending"), undefined, "Anthropic")).toThrow(
			"Anthropic stream ended without a stop reason",
		);
		expect(() =>
			assertStreamCompleted(message("pending"), undefined, { label: "Mistral", missing: "finish reason" }),
		).toThrow("Mistral stream ended without a finish reason");
	});

	it("raises an abort error before reading the stop reason", () => {
		const controller = new AbortController();
		controller.abort();
		expect(() => assertStreamCompleted(message("stop"), controller.signal, "Bedrock")).toThrow(
			expect.objectContaining({ name: "AbortError" }),
		);
	});

	it("raises the output's error text, or the adapter's own wording", () => {
		expect(() => assertStreamCompleted(message("error", "boom"), undefined, "Bedrock")).toThrow("boom");
		expect(() => assertStreamCompleted(message("aborted"), undefined, "Bedrock")).toThrow("An unknown error occurred");
		const failed = { ...message("error"), rawStopReason: "SAFETY" };
		expect(() =>
			assertStreamCompleted(failed, undefined, {
				label: "Google",
				failureMessage: ({ rawStopReason }) => `Provider stopped with: ${rawStopReason}`,
			}),
		).toThrow("Provider stopped with: SAFETY");
	});

	it("accepts a completed stream", () => {
		expect(() => assertStreamCompleted(message("toolUse"), undefined, "Anthropic")).not.toThrow();
	});
});

describe("stripStreamScratch", () => {
	it("removes every adapter's scratch field and keeps the content", () => {
		const output = message("error");
		output.content = [
			{ type: "text", text: "hi", index: 0 } as never,
			{
				type: "toolCall",
				id: "t",
				name: "read",
				arguments: { path: "a" },
				partialJson: "{",
				partialArgs: "{",
				customInput: { property: "x" },
				streamIndex: 2,
			} as never,
		];
		stripStreamScratch(output);
		expect(output.content).toEqual([
			{ type: "text", text: "hi" },
			{ type: "toolCall", id: "t", name: "read", arguments: { path: "a" } },
		]);
	});
});
