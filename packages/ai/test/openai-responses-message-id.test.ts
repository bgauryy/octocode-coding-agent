import { describe, expect, it } from "vitest";
import { replayedResponsesInput } from "./capture-responses-payload.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Usage } from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("OpenAI Responses message ID conversion", () => {
	it("generates unique fallback message IDs for multiple text blocks in one assistant turn", async () => {
		const model = getBuiltinModel("openai", "gpt-5.5");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "first answer" },
				{ type: "text", text: "visible answer" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-8",
			usage,
			stopReason: "stop",
			timestamp: Date.now() - 1000,
		};
		const context = normalizeContext({
			systemPrompt: "You are concise.",
			messages: [{ role: "user", content: "hello", timestamp: Date.now() - 2000 }, assistant],
		});

		const input = await replayedResponsesInput(model, context);
		const messageIds = input
			.filter((item) => item.type === "message" && typeof item.id === "string")
			.map((item) => item.id);

		expect(messageIds).toEqual(["msg_pi_1", "msg_pi_1_1"]);
		expect(new Set(messageIds).size).toBe(messageIds.length);
	});
});
