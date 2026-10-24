import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import type { AssistantMessage, Message, Model, SystemMessage, TranscriptContext } from "../src/types.ts";

class PayloadCaptured extends Error {}

const model: Model<"mistral-conversations"> = {
	id: "mistral-large-latest",
	name: "Mistral Large",
	api: "mistral-conversations",
	provider: "mistral",
	baseUrl: "https://api.mistral.ai",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};

const head: SystemMessage = {
	role: "system",
	content: "You are a coding agent.",
	sections: { mcp: "<mcp>none</mcp>" },
	toolsAdded: [{ name: "read", description: "read", parameters: Type.Object({}) }],
	timestamp: 1,
};
const update = (text: string, timestamp: number): SystemMessage => ({
	role: "system",
	content: "",
	sections: { mcp: text },
	timestamp,
});
const user = (content: string, timestamp: number): Message => ({ role: "user", content, timestamp });
const assistant = (content: AssistantMessage["content"], timestamp: number): AssistantMessage => ({
	role: "assistant",
	content,
	api: "mistral-conversations",
	provider: "mistral",
	model: "m",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
	timestamp,
});
const call = assistant([{ type: "toolCall", id: "call_1", name: "read", arguments: {} }], 3);
const result: Message = {
	role: "toolResult",
	toolCallId: "call_1",
	toolName: "read",
	content: [{ type: "text", text: "file" }],
	isError: false,
	timestamp: 4,
};

interface Payload {
	messages: { role: string; content: unknown }[];
}

async function run(...messages: Message[]): Promise<Payload> {
	let payload: unknown;
	const context = { messages: [head, ...messages] } as TranscriptContext;
	const events = streamMistral(model, context, {
		apiKey: "test",
		onPayload: (value) => {
			payload = value;
			throw new PayloadCaptured();
		},
	});
	for await (const event of events) void event;
	return payload as Payload;
}

const roles = (payload: Payload) => payload.messages.map((message) => message.role);

describe("Mistral system updates", () => {
	const base = [user("hello", 2), call, result];

	it("never changes the leading prompt", async () => {
		const first = await run(...base);
		const later = await run(...base, update("<mcp>docs</mcp>", 5), assistant([{ type: "text", text: "ok" }], 6));
		expect(later.messages[0]).toEqual(first.messages[0]);
		expect(JSON.stringify(later.messages[0])).not.toContain("docs");
	});

	it("holds an update that would follow a tool result and merges it into the next user message", async () => {
		const held = await run(...base, update("<mcp>docs</mcp>", 5));
		expect(roles(held)).toEqual(["system", "user", "assistant", "tool"]);

		const merged = await run(
			...base,
			update("<mcp>docs</mcp>", 5),
			assistant([{ type: "text", text: "ok" }], 6),
			user("next", 7),
		);
		expect(roles(merged)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
		const text = String(merged.messages[5].content);
		expect(text).toContain("[System update from the harness");
		expect(text).toContain("<mcp>docs</mcp>");
		expect(text.endsWith("next")).toBe(true);
		expect(merged.messages.slice(0, 4)).toEqual(held.messages);
	});

	it("keeps block content of the receiving user message", async () => {
		const merged = await run(...base, update("<mcp>docs</mcp>", 5), assistant([{ type: "text", text: "ok" }], 6), {
			role: "user",
			content: [{ type: "text", text: "next" }],
			timestamp: 7,
		});
		const content = merged.messages[5].content as { type: string; text: string }[];
		expect(content.map((chunk) => chunk.type)).toEqual(["text", "text"]);
		expect(content[0].text).toContain("<mcp>docs</mcp>");
		expect(content[1].text).toBe("next");
	});

	it("sends an update before the next assistant turn when it does not follow a tool result", async () => {
		const payload = await run(
			user("hello", 2),
			update("<mcp>docs</mcp>", 3),
			assistant([{ type: "text", text: "hi" }], 4),
		);
		expect(roles(payload)).toEqual(["system", "user", "user", "assistant"]);
		expect(String(payload.messages[2].content)).toContain("<mcp>docs</mcp>");
	});

	it("never places a user message directly after a tool message", async () => {
		const payload = await run(
			...base,
			update("<mcp>one</mcp>", 5),
			assistant([{ type: "text", text: "ok" }], 6),
			update("<mcp>two</mcp>", 7),
		);
		const list = roles(payload);
		expect(list.some((role, index) => role === "user" && list[index - 1] === "tool")).toBe(false);
		expect(list).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
		const text = String(payload.messages[5].content);
		expect(text).toContain("<mcp>one</mcp>");
		expect(text).toContain("<mcp>two</mcp>");
	});
});
