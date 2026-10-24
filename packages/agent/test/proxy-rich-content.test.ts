import { expect, it } from "vitest";
import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { processProxyEvent } from "../src/proxy/events.ts";

it("reconstructs attachment and citation updates without losing authoritative final text", () => {
	const partial: AssistantMessage = {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		content: [],
		stopReason: "pending",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	processProxyEvent({ type: "text_start", contentIndex: 0 }, partial);
	processProxyEvent({ type: "text_delta", contentIndex: 0, delta: "partial" }, partial);
	const annotations = [{ type: "citation", url: "https://example.invalid/source" }];
	processProxyEvent({ type: "text_end", contentIndex: 0, text: "Final answer", annotations }, partial);
	const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
	const event = processProxyEvent({ type: "content_update", contentIndex: 1, content: image }, partial);
	expect(event).toMatchObject({ type: "content_update", contentIndex: 1 });
	expect(partial.content).toEqual([{ type: "text", text: "Final answer", annotations }, image]);
});
