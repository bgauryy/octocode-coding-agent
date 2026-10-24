import { describe, expect, it } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Message, StreamOptions, ToolResultMessage } from "../src/types.ts";
import { createEmptyUsage } from "../src/utils/assistant-message.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type Block = { type: string; text?: string; cache_control?: { type: string; ttl?: string } };
interface Payload {
	system: Block[];
	tools?: Block[];
	messages: { role: string; content: Block[] | string }[];
}

const model = getBuiltinModel("anthropic", "claude-haiku-4-5");
const tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } } as never;

class Captured extends Error {}

async function capture(messages: Message[], options: StreamOptions & { apiKey: string }): Promise<Payload> {
	let payload: Payload | undefined;
	const context = normalizeContext({ systemPrompt: "Stable agent instructions", messages, tools: [tool] });
	await anthropicStream(model, context, {
		...options,
		onPayload: (value) => {
			payload = value as Payload;
			throw new Captured();
		},
	}).result();
	if (!payload) throw new Error("payload not captured");
	return payload;
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: 0,
	};
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const toolResult = (id: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text: "contents" }],
	isError: false,
	timestamp: 0,
});

const markers = (payload: Payload) =>
	[payload.system, payload.tools ?? [], ...payload.messages.map((message) => message.content)]
		.flat()
		.filter((block): block is Block => typeof block === "object" && block.cache_control !== undefined);
const marked = (message: Payload["messages"][number]) =>
	(Array.isArray(message.content) ? message.content : [])
		.filter((block) => block.cache_control)
		.map((block) => block.cache_control);

const apiKey = "sk-ant-api-test";
const history = [user("first"), assistant([{ type: "text", text: "reply" }]), user("second")];

describe("Anthropic history lookback breakpoint", () => {
	it("marks the previous request's tail as well as the final message", async () => {
		const payload = await capture(history, { apiKey });

		expect(marked(payload.messages[0])).toEqual([{ type: "ephemeral" }]);
		expect(payload.messages[1].role).toBe("assistant");
		expect(marked(payload.messages[2])).toEqual([{ type: "ephemeral" }]);
		// system + last tool + two history breakpoints
		expect(markers(payload)).toHaveLength(4);
	});

	it("uses the history TTL on both history breakpoints, after the longer-lived instructions", async () => {
		const payload = await capture(history, { apiKey, cacheRetention: "long" });

		expect(payload.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(marked(payload.messages[0])).toEqual([{ type: "ephemeral", ttl: "1h" }]);
		expect(marked(payload.messages[2])).toEqual([{ type: "ephemeral", ttl: "1h" }]);

		const layered = await capture(history, { apiKey, cacheRetention: "short", instructionCacheRetention: "long" });
		expect(layered.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(marked(layered.messages[0])).toEqual([{ type: "ephemeral" }]);
		expect(marked(layered.messages[2])).toEqual([{ type: "ephemeral" }]);
	});

	it("anchors on the tool results that precede the final assistant turn", async () => {
		const call = { type: "toolCall" as const, id: "call_1", name: "read", arguments: {} };
		const payload = await capture(
			[
				user("first"),
				assistant([call]),
				toolResult("call_1"),
				assistant([{ type: "text", text: "done" }]),
				user("again"),
			],
			{ apiKey },
		);

		const roles = payload.messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "user", "assistant", "user"]);
		const anchored = payload.messages.map((message) => marked(message).length);
		expect(anchored).toEqual([0, 0, 1, 0, 1]);
		expect((payload.messages[2].content as Block[])[0].type).toBe("tool_result");
		expect(markers(payload)).toHaveLength(4);
	});

	it("adds nothing when no history breakpoint is configured", async () => {
		const payload = await capture(history, { apiKey, cacheRetention: "none" });
		expect(markers(payload)).toHaveLength(0);
	});

	it("adds nothing without a previous tail", async () => {
		const payload = await capture([user("only")], { apiKey });
		expect(markers(payload)).toHaveLength(3);
	});

	it("marks only the last OAuth system block, leaving a slot for the lookback", async () => {
		const payload = await capture(history, { apiKey: "sk-ant-oat-test" });

		// The prompt block's breakpoint covers the identity line too, so a marker there would only use a slot.
		expect(payload.system.map((block) => block.cache_control)).toEqual([undefined, { type: "ephemeral" }]);
		expect(markers(payload)).toHaveLength(4);
		expect(marked(payload.messages[0])).toEqual([{ type: "ephemeral" }]);
		expect(marked(payload.messages[2])).toEqual([{ type: "ephemeral" }]);
	});

	it("marks the OAuth identity block when there is no prompt to follow it", async () => {
		let payload: Payload | undefined;
		await anthropicStream(model, normalizeContext({ messages: [user("only")], tools: [tool] }), {
			apiKey: "sk-ant-oat-test",
			onPayload: (value) => {
				payload = value as Payload;
				throw new Captured();
			},
		}).result();

		expect(payload?.system).toHaveLength(1);
		expect(payload?.system[0].cache_control).toEqual({ type: "ephemeral" });
	});

	it("skips a previous tail that cannot carry a breakpoint", async () => {
		const payload = await capture([user("   "), assistant([{ type: "text", text: "reply" }]), user("second")], {
			apiKey,
		});

		expect(markers(payload).length).toBeLessThanOrEqual(4);
		expect(payload.messages.slice(0, -1).flatMap((message) => marked(message))).toEqual([]);
	});
});
