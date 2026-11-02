import { normalizeContext } from "../src/utils/transcript.ts";
import { describe, expect, it } from "vitest";
import { stream } from "../src/api/mistral-conversations.ts";
import type { MistralChatPayload } from "../src/api/mistral-conversations/types.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";

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

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		timestamp: 3,
	};
}

const base: Message[] = [
	{
		role: "system",
		content: "You are a coding agent.",
		toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object" } }],
		timestamp: 1,
	},
	{ role: "user", content: "Read both files", timestamp: 2 },
	assistant(
		["call_a", "call_b"].map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })),
		"toolUse",
	),
	...["call_a", "call_b"].map((toolCallId): Message => ({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: 4,
	})),
];

async function capture(messages: Message[]): Promise<MistralChatPayload> {
	let payload: MistralChatPayload | undefined;
	for await (const _event of stream(model, normalizeContext({ messages }), {
		apiKey: "test",
		onPayload(value) {
			payload = value as MistralChatPayload;
			throw new Error("Payload captured before transport");
		},
	})) {
		// Drain the locally terminated stream; no provider request is sent.
	}
	expect(payload).toBeDefined();
	return payload!;
}

// The pinned mistral-common validator (aecb5fb) permits user after tool. These tests protect
// call/result pairing and real user input; they do not claim live hosted endpoint coverage.
describe("Mistral input after interrupted tool turns", () => {
	it.each([
		["empty abort", assistant([], "aborted")],
		["partial abort", assistant([{ type: "text", text: "unfinished" }], "aborted")],
		["errored turn", assistant([], "error")],
		["no assistant turn", undefined],
	] as const)("preserves results, the new prompt and the existing prefix after %s", async (_name, interrupted) => {
		const before = await capture(base);
		const messages: Message[] = [
			...base,
			...(interrupted ? [interrupted] : []),
			{ role: "user", content: "Now inspect the other file", timestamp: 6 },
		];
		const original = structuredClone(messages);
		const payload = await capture(messages);
		expect(payload.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"tool",
			"tool",
			"user",
		]);
		expect(payload.messages.at(-1)?.content).toBe("Now inspect the other file");
		expect(payload.messages.slice(0, -1)).toEqual(before.messages);
		expect(payload.tools).toEqual(before.tools);
		const calls = payload.messages.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? []);
		const results = payload.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId);
		expect(results).toEqual(calls);
		expect(new Set(calls).size).toBe(2);
		expect(messages).toEqual(original);

		const later = await capture([
			...messages,
			assistant([{ type: "text", text: "done" }], "stop"),
			{ role: "user", content: "Continue", timestamp: 8 },
		]);
		expect(later.messages.slice(0, payload.messages.length)).toEqual(payload.messages);
	});

	it("retains a completed assistant answer before the next prompt", async () => {
		const payload = await capture([
			...base,
			assistant([{ type: "text", text: "Finished reading" }], "stop"),
			{ role: "user", content: "Continue", timestamp: 6 },
		]);
		expect(payload.messages.slice(-2)).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "Finished reading" }], prefix: false },
			{ role: "user", content: "Continue" },
		]);
	});
});
