import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { type ProxyAssistantMessageEvent, processProxyEvent } from "../src/proxy/events.ts";

function pendingMessage(): AssistantMessage {
	return {
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
}

describe("processProxyEvent content guards", () => {
	const toolCall = { type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "a" } };
	const cases: [ProxyAssistantMessageEvent, string][] = [
		[{ type: "text_delta", contentIndex: 0, delta: "x" }, "Received text_delta for non-text content"],
		[{ type: "text_end", contentIndex: 0 }, "Received text_end for non-text content"],
		[{ type: "thinking_delta", contentIndex: 0, delta: "x" }, "Received thinking_delta for non-thinking content"],
		[{ type: "thinking_end", contentIndex: 0 }, "Received thinking_end for non-thinking content"],
		[{ type: "toolcall_delta", contentIndex: 0, delta: "{}" }, "Received toolcall_delta for non-toolCall content"],
		[{ type: "toolcall_end", contentIndex: 0, toolCall }, "Received toolcall_end for non-toolCall content"],
	];

	it.each(cases)("rejects %j for missing or mismatched content", (event, message) => {
		expect(() => processProxyEvent(event, pendingMessage())).toThrow(message);

		const mismatched = pendingMessage();
		mismatched.content[0] = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		expect(() => processProxyEvent(event, mismatched)).toThrow(message);
	});

	it("completes a tool call that was started", () => {
		const partial = pendingMessage();
		processProxyEvent({ type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" }, partial);
		const event = processProxyEvent({ type: "toolcall_end", contentIndex: 0, toolCall }, partial);
		expect(event).toMatchObject({ type: "toolcall_end", contentIndex: 0, toolCall });
		expect(partial.content[0]).toEqual(toolCall);
	});
});
