import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "../src/types.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

function assistant(id: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: {} }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

const result = (id: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp: 1,
});
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });

describe("tool results of skipped assistant messages", () => {
	it("removes an aborted assistant message and its tool result as a pair", () => {
		const out = transformMessages([user("a"), assistant("t1", "aborted"), result("t1"), user("b")], model);
		expect(out.map((m) => m.role)).toEqual(["user", "user"]);
	});

	it("keeps a normal assistant message with its tool result", () => {
		const out = transformMessages([user("a"), assistant("t1", "toolUse"), result("t1"), user("b")], model);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
	});

	it("still synthesizes a result for an orphaned call of a kept message", () => {
		const out = transformMessages([user("a"), assistant("t1", "toolUse"), user("b")], model);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
	});
});
