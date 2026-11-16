import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as bedrockStream } from "../src/api/bedrock-converse-stream.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Message, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/**
 * AWS lists a 20K-token cache limit for Amazon Nova (https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html,
 * "Supported models, Regions, and explicit caching limits", fetched 2026-11-08) and does not say what happens past it.
 * The adapter fails safe: a Nova cache point goes only where the estimated tokens before it, in Converse order (tools,
 * system, messages), are under 20K.
 */

import { bedrockResponse, bedrockTextEvents } from "./bedrock-fixtures.ts";
type CachePoint = { type: string; ttl?: string };
type Block = { cachePoint?: CachePoint; [key: string]: unknown };
interface Payload {
	system?: Block[];
	toolConfig?: { tools: Block[] };
	messages: { role: string; content: Block[] }[];
}

/** Far past 20K tokens at any characters-per-token ratio a tokenizer could plausibly have. */
const HUGE = "x".repeat(120_000);

async function payloadFor(
	model: Model<"bedrock-converse-stream">,
	input: { system?: string; toolDescription?: string; messages: Message[] },
): Promise<Payload> {
	let payload: Payload | undefined;
	const context = normalizeContext({
		systemPrompt: input.system ?? "Stable instructions",
		messages: input.messages,
		tools: [
			{
				name: "read",
				description: input.toolDescription ?? "Read a file",
				parameters: Type.Object({ path: Type.String() }),
			},
		],
	});
	await bedrockStream(model, context, {
		env: {},
		apiKey: "test",
		fetch: async () => bedrockResponse(bedrockTextEvents),
		cacheRetention: "short",
		instructionCacheRetention: "short",
		onPayload: (value) => {
			payload = structuredClone(value) as Payload;
			return value;
		},
	}).result();
	if (!payload) throw new Error("payload not captured");
	return payload;
}

function points(payload: Payload): CachePoint[] {
	return [
		...(payload.toolConfig?.tools ?? []),
		...(payload.system ?? []),
		...payload.messages.flatMap((message) => message.content),
	].flatMap((block) => (block.cachePoint ? [block.cachePoint] : []));
}

const user = (text: string, timestamp: number): Message => ({ role: "user", content: text, timestamp });

const nova = getBuiltinModel("amazon-bedrock", "us.amazon.nova-pro-v1:0");

describe("Bedrock Nova 20K-token cache cap", () => {
	it("keeps every Nova cache point when the whole prefix is small", async () => {
		const payload = await payloadFor(nova, { messages: [user("Hello", 1)] });
		expect(payload.system?.filter((block) => block.cachePoint)).toHaveLength(1);
		expect(payload.messages.at(-1)?.content.at(-1)?.cachePoint).toEqual({ type: "default" });
	});

	it("leaves out every Nova cache point when the tools before the first one exceed 20K tokens", async () => {
		const payload = await payloadFor(nova, { toolDescription: HUGE, messages: [user("Hello", 1)] });
		expect(points(payload)).toEqual([]);
		// The content itself is still sent whole.
		expect(JSON.stringify(payload.toolConfig?.tools)).toContain(HUGE);
	});

	it("leaves out every Nova cache point when the system prompt pushes its prefix past 20K tokens", async () => {
		const payload = await payloadFor(nova, { system: HUGE, messages: [user("Hello", 1)] });
		expect(points(payload)).toEqual([]);
	});

	it("keeps the system point but leaves out the history point when the history pushes past 20K tokens", async () => {
		const payload = await payloadFor(nova, { messages: [user(HUGE, 1)] });
		expect(payload.system?.filter((block) => block.cachePoint)).toHaveLength(1);
		expect(payload.messages.flatMap((message) => message.content).some((block) => block.cachePoint)).toBe(false);
	});

	it("does not cap Claude models, whose cache has no 20K limit", async () => {
		const claude = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-6");
		const payload = await payloadFor(claude, { toolDescription: HUGE, messages: [user(HUGE, 1)] });
		expect(points(payload).length).toBeGreaterThanOrEqual(3);
	});
});
