import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as bedrockStream } from "../src/api/bedrock-converse-stream.ts";
import { capLayeredCacheRetention } from "../src/api/bedrock-converse-stream/cache-points.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Message, StreamOptions, SystemMessage, Tool } from "../src/types.ts";
import { createEmptyUsage } from "../src/utils/assistant-message.ts";
import { normalizeContext, type TranscriptContext } from "../src/utils/transcript.ts";

/**
 * Bedrock Claude checks only about 20 content blocks back from a cache point, and unlike the Claude API it does not
 * count a run of tool calls or results as one position. A long or parallel tool turn between two requests would push
 * the previous write out of reach, so the previous request's tail gets its own cache point when a slot is free.
 */

const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
const tool: Tool = { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };

type CachePoint = { type: string; ttl?: string };
type Block = { text?: string; cachePoint?: CachePoint; toolResult?: unknown; toolUse?: unknown };
interface Payload {
	system?: Block[];
	toolConfig?: { tools: Block[] };
	messages: { role: string; content: Block[] }[];
}

class Captured extends Error {}

async function capture(context: TranscriptContext, options: StreamOptions = {}): Promise<Payload> {
	let payload: Payload | undefined;
	await bedrockStream(model, context, {
		env: {},
		...options,
		onPayload: (value) => {
			payload = structuredClone(value) as Payload;
			throw new Captured();
		},
	}).result();
	if (!payload) throw new Error("payload not captured");
	return payload;
}

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: createEmptyUsage(),
	stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
	timestamp: 1,
});
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const call = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: id } });
const result = (id: string): Message => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text: `contents of ${id}` }],
	isError: false,
	timestamp: 1,
});

function context(messages: Message[], options: { systemPrompt?: string; tools?: Tool[]; sections?: boolean } = {}) {
	const base = normalizeContext({
		systemPrompt: options.systemPrompt ?? "Stable instructions",
		messages,
		tools: options.tools ?? [tool],
	});
	if (!options.sections) return base;
	const [head, ...rest] = base.messages;
	const sections = { docs: "<docs>d</docs>", project_context: "<project>p</project>" };
	return { messages: [{ ...(head as SystemMessage), sections }, ...rest] } as TranscriptContext;
}

const points = (payload: Payload) =>
	[...(payload.toolConfig?.tools ?? []), ...(payload.system ?? []), ...payload.messages.flatMap((m) => m.content)]
		.filter((block) => block.cachePoint)
		.map((block) => block.cachePoint!);
const marked = (payload: Payload) => payload.messages.map((message) => message.content.some((b) => b.cachePoint));

// Twelve parallel calls: 12 toolUse + 12 toolResult blocks between the two writes, past the 20-block window.
const ids = Array.from({ length: 12 }, (_, index) => `c${index}`);
const parallelTurn: Message[] = [user("task"), assistant(ids.map(call)), ...ids.map(result)];

describe("Bedrock Claude history lookback cache point", () => {
	it("marks the previous request's tail as well as the final message", async () => {
		const payload = await capture(context([...parallelTurn, assistant(ids.map(call)), ...ids.map(result)]));
		expect(marked(payload)).toEqual([false, false, true, false, true]);
		expect(points(payload)).toHaveLength(4);
		// The tail point follows the last tool result, after every content block of the message.
		expect(payload.messages[2].content.at(-1)?.cachePoint).toBeDefined();
	});

	it("keeps the tools cache point without a system prompt and still adds the lookback", async () => {
		const payload = await capture(context(parallelTurn, { systemPrompt: "" }));
		expect(payload.system).toBeUndefined();
		expect(payload.toolConfig?.tools.at(-1)?.cachePoint).toBeDefined();
		expect(marked(payload)).toEqual([true, false, true]);
		expect(points(payload)).toHaveLength(3);
	});

	it("never exceeds four cache points with a split system prompt", async () => {
		const payload = await capture(context(parallelTurn, { sections: true }), {
			instructionCacheBoundary: "project_context",
		});
		expect(payload.system?.filter((block) => block.cachePoint)).toHaveLength(2);
		expect(points(payload).length).toBeLessThanOrEqual(4);
		expect(payload.messages.at(-1)?.content.at(-1)?.cachePoint).toBeDefined();
	});

	it("uses the history TTL after the longer-lived instruction points", async () => {
		const payload = await capture(context(parallelTurn), {
			cacheRetention: "short",
			instructionCacheRetention: "long",
		});
		expect(points(payload).map((point) => point.ttl)).toEqual(["1h", "1h", undefined, undefined]);
	});

	it("adds nothing without a previous tail or with caching off", async () => {
		expect(marked(await capture(context([user("only")])))).toEqual([true]);
		expect(points(await capture(context(parallelTurn), { cacheRetention: "none" }))).toEqual([]);
	});

	it("keeps the previous request's content as a prefix of the next and marks its write position again", async () => {
		const first = await capture(context(parallelTurn));
		const next = await capture(context([...parallelTurn, assistant([call("d1")]), result("d1")]));
		const tail = first.messages.length - 1;
		// A cache point marks a position; it is not part of the cached content.
		const content = (messages: Payload["messages"]) =>
			JSON.stringify(messages.map((message) => message.content.filter((block) => !block.cachePoint)));
		expect(content(next.messages.slice(0, tail + 1))).toBe(content(first.messages));
		expect(JSON.stringify([next.toolConfig, next.system])).toBe(JSON.stringify([first.toolConfig, first.system]));
		expect(next.messages[tail].content.at(-1)).toEqual(first.messages[tail].content.at(-1));
		expect(next.messages[tail].content.at(-1)?.cachePoint).toBeDefined();
	});
});

describe("Bedrock layered TTL cap", () => {
	it("caps long history behind short instruction points, since one-hour points must come first", () => {
		expect(capLayeredCacheRetention(model, { history: "long", instructions: "short" })).toEqual({
			history: "short",
			instructions: "short",
		});
		expect(capLayeredCacheRetention(model, { history: "long", instructions: "none" })).toEqual({
			history: "long",
			instructions: "none",
		});
		expect(capLayeredCacheRetention(model, { history: "short", instructions: "long" })).toEqual({
			history: "short",
			instructions: "long",
		});
	});
});
