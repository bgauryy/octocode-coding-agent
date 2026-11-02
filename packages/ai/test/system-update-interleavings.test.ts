import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessage, Message, Model, SystemMessage, TranscriptContext } from "../src/types.ts";

// Every assertion here reads the payload the adapter hands to `onPayload`: roles, tool call ids and
// version markers are taken from the built request, never from the transcript.

class PayloadCaptured extends Error {}

const baseModel = {
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1000,
};
const mistralModel: Model<"mistral-conversations"> = {
	...baseModel,
	id: "mistral-large-latest",
	name: "Mistral Large",
	api: "mistral-conversations",
	provider: "mistral",
	baseUrl: "https://api.mistral.ai",
};

const head: SystemMessage = {
	role: "system",
	content: "You are a coding agent.",
	sections: { mcp: "<mcp>MCP v0</mcp>" },
	toolsAdded: [{ name: "read", description: "read", parameters: Type.Object({}) }],
	timestamp: 1,
};
const version = (n: number): SystemMessage => ({
	role: "system",
	content: "",
	sections: { mcp: `<mcp>MCP v${n}</mcp>` },
	timestamp: 10 + n,
});
const user = (content: string): Message => ({ role: "user", content, timestamp: 2 });
const assistant = (
	content: AssistantMessage["content"],
	stopReason?: AssistantMessage["stopReason"],
): AssistantMessage => ({
	role: "assistant",
	content,
	api: "mistral-conversations",
	provider: "mistral",
	model: "mistral-large-latest",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: stopReason ?? (content.some((block) => block.type === "toolCall") ? "toolUse" : "stop"),
	timestamp: 3,
});
const calls = (...ids: string[]) =>
	assistant(ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: { id } })));
const text = (value: string) => assistant([{ type: "text", text: value }]);
const result = (id: string): Message => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text: `result ${id}` }],
	isError: false,
	timestamp: 4,
});

type Start = (
	context: TranscriptContext,
	options: { apiKey: string; onPayload: (value: unknown) => never },
) => AsyncIterable<unknown>;

async function capture(start: Start, messages: Message[]): Promise<Record<string, unknown>> {
	let payload: unknown;
	const events = start({ messages: [head, ...messages] } as TranscriptContext, {
		apiKey: "test",
		onPayload: (value) => {
			payload = value;
			throw new PayloadCaptured();
		},
	});
	for await (const event of events) void event;
	expect(payload, "payload captured").toBeDefined();
	return payload as Record<string, unknown>;
}

interface MistralMessage {
	role: string;
	content?: unknown;
	toolCalls?: { id: string }[];
	toolCallId?: string;
}
const mistral = async (...messages: Message[]) =>
	(await capture((context, options) => streamMistral(mistralModel, context, options), messages))
		.messages as MistralMessage[];

/** Version numbers of the markers in wire order, e.g. [0, 2, 3]. */
const markers = (value: unknown): number[] =>
	[...JSON.stringify(value).matchAll(/MCP v(\d+)/g)].map((match) => Number(match[1]));

/**
 * The newest version is present exactly once, every version at most once, and versions never go
 * back in wire order (no older update after a newer one).
 */
function expectNewestStateOnce(value: unknown, newest: number): void {
	const seen = markers(value);
	expect(
		seen.filter((n) => n === newest),
		`newest v${newest} once in ${JSON.stringify(seen)}`,
	).toHaveLength(1);
	expect(new Set(seen).size, `no duplicate in ${JSON.stringify(seen)}`).toBe(seen.length);
	expect(seen, "ascending versions").toEqual([...seen].sort((a, b) => a - b));
	expect(seen.at(-1)).toBe(newest);
}

/**
 * Mistral wire rules: one leading system message; no user message right after a tool message; each
 * tool message answers a call of the assistant message before it, and every call is answered once.
 */
function expectValidMistralSequence(messages: MistralMessage[]): void {
	const roles = messages.map((message) => message.role);
	expect(roles[0]).toBe("system");
	expect(roles.slice(1), "no later system message").not.toContain("system");
	for (let index = 1; index < roles.length; index++) {
		expect(`${roles[index - 1]}->${roles[index]}`, `roles ${roles.join(",")}`).not.toBe("tool->user");
	}
	let open: string[] = [];
	for (const message of messages) {
		if (message.role === "tool") {
			expect(open, `result ${message.toolCallId} answers an open call`).toContain(message.toolCallId);
			open = open.filter((id) => id !== message.toolCallId);
			continue;
		}
		expect(open, `calls answered before ${message.role}`).toEqual([]);
		open = message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.id) : [];
	}
}

describe("Mistral system update interleavings", () => {
	const cases: [string, Message[], number][] = [
		["call, update, result", [user("go"), calls("c1"), version(1), result("c1")], 1],
		["result, update, result", [user("go"), calls("c1", "c2"), result("c1"), version(1), result("c2")], 1],
		[
			"v1, v2, v3 between parallel results",
			[
				user("go"),
				calls("c1", "c2", "c3"),
				version(1),
				result("c1"),
				version(2),
				result("c2"),
				version(3),
				result("c3"),
			],
			3,
		],
		["update after a call whose result never came", [user("go"), calls("c1"), version(1)], 1],
		["update after an answer without tool calls", [user("go"), text("hi"), version(1)], 1],
		["update as the last message after a result", [user("go"), calls("c1"), result("c1"), version(1)], 1],
		["update before the next user message", [user("go"), text("hi"), version(1), user("next")], 1],
		[
			"update after an errored turn that followed a result",
			[user("go"), calls("c1"), result("c1"), assistant([], "error"), version(1)],
			1,
		],
		[
			"update after an aborted turn with a partial call that followed a result",
			[
				user("go"),
				calls("c1"),
				result("c1"),
				assistant([{ type: "toolCall", id: "c2", name: "read", arguments: {} }], "aborted"),
				version(1),
			],
			1,
		],
		[
			"v1, v2 after an errored turn, then v3 after a result",
			[
				user("go"),
				calls("c1"),
				result("c1"),
				version(1),
				assistant([], "error"),
				version(2),
				calls("c2"),
				result("c2"),
				version(3),
			],
			3,
		],
	];
	for (const [name, messages, newest] of cases) {
		it(`${name}: valid sequence with the newest state once`, async () => {
			const payload = await mistral(...messages);
			expectValidMistralSequence(payload);
			expectNewestStateOnce(payload, newest);
		});
	}

	// Control: without the update the errored turn alone leaves a valid sequence ending on the tool result.
	it("an errored turn after a result without an update ends on the tool message", async () => {
		const payload = await mistral(user("go"), calls("c1"), result("c1"), assistant([], "error"));
		expectValidMistralSequence(payload);
		expect(payload.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
	});

	it("keeps every tool call id paired across parallel results and updates", async () => {
		const payload = await mistral(user("go"), calls("c1", "c2"), result("c1"), version(1), result("c2"), version(2));
		const ids = payload.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id));
		expect(ids).toHaveLength(2);
		expect(payload.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(ids);
	});

	it("holds only the newest state across two requests", async () => {
		const first = [user("go"), calls("c1", "c2"), result("c1"), version(1), result("c2"), version(2)];
		const second = [...first, calls("c3"), version(3), result("c3")];
		const before = await mistral(...first);
		const after = await mistral(...second);
		expectNewestStateOnce(before, 2);
		expectNewestStateOnce(after, 3);
		expect(markers(after[0])).toEqual([3]);
		expectValidMistralSequence(after);
	});
});

/** Cache breakpoints move to the newest message by design; they are not part of the compared bytes. */
function withoutCacheMarkers(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value
			.filter((entry) => !(entry && typeof entry === "object" && Object.keys(entry).join() === "cachePoint"))
			.map(withoutCacheMarkers);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== "cache_control")
				.map(([key, entry]) => [key, withoutCacheMarkers(entry)]),
		);
	}
	return value;
}

interface Route {
	name: string;
	start: Start;
	/** The prompt fields that must stay identical, and the list that later requests only extend. */
	split: (payload: Record<string, unknown>) => { prompt: unknown; turns: unknown[] };
}

const model = <TApi extends string>(api: TApi, provider: string, supportsMidConvoSystemMessages?: boolean) =>
	({
		...baseModel,
		id: api === "anthropic-messages" ? "claude-sonnet-4-5" : "vendor/model",
		name: "fixture",
		api,
		provider,
		baseUrl: "https://example.invalid",
		...(supportsMidConvoSystemMessages === undefined ? {} : { compat: { supportsMidConvoSystemMessages } }),
	}) as never;

const routes: Route[] = [
	...[false, true].flatMap((mid): Route[] => [
		{
			name: `anthropic-messages mid=${mid}`,
			start: (context, options) => streamAnthropic(model("anthropic-messages", "anthropic", mid), context, options),
			// Placing a breakpoint turns string content into one text block; both forms carry the same text.
			split: (payload) => ({
				prompt: payload.system,
				turns: (payload.messages as { content: unknown }[]).map((message) =>
					typeof message.content === "string"
						? { ...message, content: [{ type: "text", text: message.content }] }
						: message,
				),
			}),
		},
		{
			name: `openai-completions mid=${mid}`,
			start: (context, options) => streamCompletions(model("openai-completions", "openrouter", mid), context, options),
			split: (payload) => ({ prompt: undefined, turns: payload.messages as unknown[] }),
		},
		{
			name: `openai-responses mid=${mid}`,
			start: (context, options) => streamResponses(model("openai-responses", "openai", mid), context, options),
			split: (payload) => ({ prompt: payload.instructions, turns: payload.input as unknown[] }),
		},
	]),
	{
		name: "google-generative-ai",
		start: (context, options) => streamGoogle(model("google-generative-ai", "google"), context, options),
		split: (payload) => ({
			prompt: (payload.config as { systemInstruction?: unknown }).systemInstruction,
			turns: payload.contents as unknown[],
		}),
	},
	{
		name: "bedrock-converse-stream",
		start: (context, options) =>
			streamBedrock(model("bedrock-converse-stream", "amazon-bedrock"), context, { ...options, region: "us-east-1" }),
		split: (payload) => ({ prompt: payload.system, turns: payload.messages as unknown[] }),
	},
];

// Consecutive requests of one agent loop: parallel results with updates between them, an update between a
// call and its result, an update as the last message after an answer, then a new user turn.
const requests: [Message[], number][] = (() => {
	const r0 = [user("go")];
	const r1 = [...r0, calls("c1", "c2"), result("c1"), version(1), result("c2")];
	const r2 = [...r1, calls("c3"), version(2), result("c3")];
	const r3 = [...r2, text("done"), version(3)];
	const r4 = [...r3, text("still here"), user("next")];
	// A request that failed after a tool result, an update, then the retried turn.
	const r5 = [...r4, calls("c4"), result("c4"), assistant([], "error"), version(4)];
	const r6 = [...r5, calls("c5"), result("c5")];
	return [
		[r0, 0],
		[r1, 1],
		[r2, 2],
		[r3, 3],
		[r4, 3],
		[r5, 4],
		[r6, 4],
	];
})();

describe("append routes keep earlier request bytes and place each update once in order", () => {
	for (const route of routes) {
		it(route.name, async () => {
			const payloads = [];
			for (const [messages] of requests) payloads.push(withoutCacheMarkers(await capture(route.start, messages)));
			for (const [index, payload] of payloads.entries()) {
				const newest = requests[index][1];
				const { prompt, turns } = route.split(payload as Record<string, unknown>);
				const seen = markers([prompt ?? null, turns]);
				expect(seen.at(-1), `${route.name} request ${index} ends on v${newest}`).toBe(newest);
				for (let n = 1; n <= newest; n++) {
					expect(
						seen.filter((v) => v === n),
						`${route.name} request ${index}: v${n} once in ${seen}`,
					).toHaveLength(1);
				}
				expect(seen, "ascending versions").toEqual([...seen].sort((a, b) => a - b));
				if (index === 0) continue;
				const previous = route.split(payloads[index - 1] as Record<string, unknown>);
				const current = route.split(payload as Record<string, unknown>);
				expect(current.prompt, `${route.name} request ${index} prompt`).toEqual(previous.prompt);
				expect(current.turns.slice(0, previous.turns.length), `${route.name} request ${index} turns`).toEqual(
					previous.turns,
				);
				const before = JSON.stringify(previous.turns).slice(0, -1);
				expect(
					JSON.stringify(current.turns).startsWith(before),
					`${route.name} request ${index} extends ${index - 1}`,
				).toBe(true);
			}
		});
	}
});
