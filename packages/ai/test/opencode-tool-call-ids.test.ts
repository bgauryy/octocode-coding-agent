import { describe, expect, it } from "vitest";
import { stream as responsesStream } from "../src/api/openai-responses.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";
import { createEmptyUsage } from "../src/utils/assistant-message.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

class Captured extends Error {}

type Item = { type?: string; call_id?: string; id?: string };

/** The function call and its output for a `call|item` tool call recorded on direct OpenAI, replayed to `model`. */
async function replayedCall(model: Model<"openai-responses">): Promise<Item[]> {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_abc|fc_123", name: "read", arguments: { path: "a" } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-6-luna",
		usage: createEmptyUsage(),
		stopReason: "toolUse",
		timestamp: 0,
	};
	const messages: Message[] = [
		{ role: "user", content: "Read a", timestamp: 0 },
		assistant,
		{
			role: "toolResult",
			toolCallId: "call_abc|fc_123",
			toolName: "read",
			content: [{ type: "text", text: "contents" }],
			isError: false,
			timestamp: 0,
		},
	];
	let input: Item[] = [];
	await responsesStream(model, normalizeContext({ systemPrompt: "Be brief.", messages }), {
		apiKey: "oc_sk_test",
		onPayload: (payload) => {
			input = (payload as { input: Item[] }).input;
			throw new Captured();
		},
	}).result();
	return input.filter((item) => item.type === "function_call" || item.type === "function_call_output");
}

describe("OpenCode Responses tool-call ids", () => {
	it("keeps a foreign call id and pairs its item id on Go as on Zen", async () => {
		const zen = await replayedCall(getBuiltinModel("opencode", "gpt-5.2"));
		const go = await replayedCall(getBuiltinModel("opencode-go", "gpt-6-luna"));
		expect(zen).toEqual([
			expect.objectContaining({ type: "function_call", call_id: "call_abc", id: expect.stringMatching(/^fc_/) }),
			expect.objectContaining({ type: "function_call_output", call_id: "call_abc" }),
		]);
		expect(go).toEqual(zen);
	});
});
