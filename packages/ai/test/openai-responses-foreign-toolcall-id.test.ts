import { describe, expect, it } from "vitest";
import { replayedResponsesInput } from "./capture-responses-payload.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, ToolResultMessage, Usage } from "../src/types.ts";
import { fastHash } from "../src/utils/hash.ts";

const COPILOT_RAW_TOOL_CALL_ID =
	"call_4VnzVawQXPB9MgYib7CiQFEY|I9b95oN1wD/cHXKTw3PpRkL6KkCtzTJhUxMouMWYwHeTo2j3htzfSk7YPx2vifiIM4g3A8XXyOj8q4Bt6SLUG7gqY1E3ELkrkVQNHglRfUmWj84lqxJY+Puieb3VKyX0FB+83TUzn91cDMF/4gzt990IzqVrc+nIb9RRscRD070Du16q1glydVjWR0SBJsE6TbY/esOjFpqplogQqrajm1eI++f3eLi73R6q7hVusY0QbeFySVxABCjhN0lXB04caBe1rzHjYzul6MAXj7uq+0r17VLq+yrtyYhN12wkmFqHeqTyEei6EFPbMy24Nc+IbJlkP0OCg02W+gOnyBFcbi2ctvJFSOhSjt1CqBdqCnnhwUqXjbWiT0wh3DmLScRgTHmGkaI+oAcQQjfic65nxj+TnEkReA==";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("OpenAI Responses foreign tool call ID normalization", () => {
	it("hashes foreign Copilot tool item IDs into a bounded Responses-safe fc_<hash> shape", async () => {
		const model = getBuiltinModel("openai", "gpt-5.5");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: COPILOT_RAW_TOOL_CALL_ID,
					name: "edit",
					arguments: { path: "src/styles/app.css" },
				},
			],
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5.5",
			usage,
			stopReason: "toolUse",
			timestamp: Date.now() - 2000,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: COPILOT_RAW_TOOL_CALL_ID,
			toolName: "edit",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now() - 1000,
		};
		const context = normalizeContext({
			systemPrompt: "You are concise.",
			messages: [{ role: "user", content: "Use the tool.", timestamp: Date.now() - 3000 }, assistant, toolResult],
		});

		const input = await replayedResponsesInput(model, context);
		const functionCall = input.find((item) => item.type === "function_call");

		expect(functionCall).toBeDefined();
		const id = functionCall?.id as string;

		const expectedItemId = `fc_${fastHash(COPILOT_RAW_TOOL_CALL_ID.split("|")[1])}`;
		expect(id).toBe(expectedItemId);
		expect(id.length).toBeLessThanOrEqual(64);
		expect(id).toMatch(/^fc_[A-Za-z0-9]+$/);
	});
});
