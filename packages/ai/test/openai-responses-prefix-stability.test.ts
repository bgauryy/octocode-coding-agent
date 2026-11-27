import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type OpenAIResponsesOptions, stream } from "../src/api/openai-responses.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Message, Model, SystemMessage, Tool, TranscriptContext } from "../src/types.ts";

// Request N+1 must repeat request N's input byte for byte up to N's last cache breakpoint, and keep every
// top-level field that OpenAI documents as part of the cached prefix. Each request runs through stream(),
// replaying the assistant messages that the previous mocked response produced.

type Item = Record<string, unknown>;
interface Payload {
	model: string;
	input: Item[];
	tools?: unknown[];
	reasoning?: { effort?: string };
	text?: unknown;
	parallel_tool_calls?: unknown;
	prompt_cache_key?: string;
	prompt_cache_options?: unknown;
	prompt_cache_retention?: string;
}

const PREFIX_FIELDS = [
	"model",
	"tools",
	"text",
	"parallel_tool_calls",
	"prompt_cache_key",
	"prompt_cache_options",
	"prompt_cache_retention",
] as const;

const tool = (name: string): Tool => ({
	name,
	description: `The ${name} tool.`,
	parameters: Type.Object({ q: Type.String() }),
});

const leading: SystemMessage = {
	role: "system",
	content: "You are a coding agent.",
	sections: { project_context: "<project>Project.</project>", skills: "<skills>Skills.</skills>" },
	toolsAdded: [tool("lookup")],
	timestamp: 0,
};

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// A reply from another provider: its signed thinking is dropped and its text gets a fallback item id.
const foreignReply: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "foreign plan", thinkingSignature: "foreign-signature" },
		{ type: "text", text: "Earlier answer." },
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-5",
	usage,
	stopReason: "stop",
	timestamp: 0,
};

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

const reasoning = (id: string) => ({
	type: "reasoning",
	id,
	summary: [{ type: "summary_text", text: `${id} summary` }],
	encrypted_content: `${id}-encrypted`,
});
const text = (id: string, value: string) => ({
	type: "message",
	id,
	role: "assistant",
	status: "completed",
	phase: "final_answer",
	content: [{ type: "output_text", text: value, annotations: [] }],
});
const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' };

function sse(items: object[]): string {
	const events: object[] = [{ type: "response.created", response: { id: "resp" } }];
	items.forEach((item, index) => {
		events.push({ type: "response.output_item.added", output_index: index, item });
		events.push({ type: "response.output_item.done", output_index: index, item });
	});
	events.push({
		type: "response.completed",
		response: {
			id: "resp",
			status: "completed",
			usage: { input_tokens: 2000, output_tokens: 10, total_tokens: 2010, input_tokens_details: { cached_tokens: 0 } },
		},
	});
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function send(
	model: Model<"openai-responses">,
	messages: Message[],
	reply: object[],
	options: OpenAIResponsesOptions,
): Promise<{ payload: Payload; message: AssistantMessage }> {
	let payload: Payload | undefined;
	const message = await stream(model, { messages } as TranscriptContext, {
		apiKey: "sk-test",
		sessionId: "session-1",
		cacheRetention: "short",
		instructionCacheRetention: "long",
		instructionCacheBoundary: "project_context",
		...options,
		onPayload: (value) => {
			payload = structuredClone(value) as Payload;
			return undefined;
		},
		fetch: async () => new Response(sse(reply), { headers: { "content-type": "text/event-stream" } }),
	}).result();
	expect(message.stopReason, message.errorMessage).not.toBe("error");
	return { payload: payload!, message };
}

interface Step {
	label: string;
	append: (previous: AssistantMessage | undefined) => Message[];
	effort: OpenAIResponsesOptions["reasoningEffort"];
	reply: object[];
}

/** A tool loop, a reasoning item, an effort change, a mid-conversation tool addition and a plain turn. */
function steps(changeEffort: boolean): Step[] {
	const later = changeEffort ? "low" : "high";
	return [
		{
			label: "first turn",
			append: () => [leading, user("zero"), foreignReply, user("one")],
			effort: "high",
			reply: [reasoning("rs_1"), call],
		},
		{
			label: "tool result",
			append: (previous) => [previous!, { ...toolResult }],
			effort: later,
			reply: [reasoning("rs_2"), text("msg_2", "Looked it up.")],
		},
		{
			label: "system update adding a tool",
			append: (previous) => [
				previous!,
				{ role: "system", content: "Review mode.", toolsAdded: [tool("grep")], timestamp: 0 },
				user("two"),
			],
			effort: later,
			reply: [text("msg_3", "Reviewing.")],
		},
		{
			label: "plain turn",
			append: (previous) => [previous!, user("three")],
			effort: later,
			reply: [text("msg_4", "ok")],
		},
	];
}

const toolResult: Message = {
	role: "toolResult",
	toolCallId: "call_1|fc_1",
	toolName: "lookup",
	content: [{ type: "text", text: "found" }],
	isError: false,
	timestamp: 0,
};

async function runConversation(model: Model<"openai-responses">, changeEffort: boolean): Promise<Payload[]> {
	const transcript: Message[] = [];
	const payloads: Payload[] = [];
	let previous: AssistantMessage | undefined;
	for (const step of steps(changeEffort)) {
		transcript.push(...step.append(previous));
		const { payload, message } = await send(model, transcript, step.reply, { reasoningEffort: step.effort });
		payloads.push(payload);
		previous = message;
	}
	return payloads;
}

function breakpoints(payload: Payload): { index: number; ttl?: string }[] {
	const found: { index: number; ttl?: string }[] = [];
	payload.input.forEach((item, index) => {
		const content = Array.isArray(item.content) ? (item.content as Item[]) : [];
		for (const block of content) {
			const breakpoint = block.prompt_cache_breakpoint as { ttl?: string } | undefined;
			if (breakpoint) found.push({ index, ttl: breakpoint.ttl });
		}
	});
	return found;
}

function expectStablePrefix(payloads: Payload[]): void {
	for (let n = 1; n < payloads.length; n++) {
		const [before, after] = [payloads[n - 1], payloads[n]];
		for (const field of PREFIX_FIELDS) expect(after[field], `${field} in request ${n + 1}`).toEqual(before[field]);
		expect(after.reasoning?.effort, `reasoning.effort in request ${n + 1}`).toBe(before.reasoning?.effort);
		// Byte prefix: every item of request N, serialized, starts request N+1.
		const serialize = (items: Item[]) => items.map((item) => JSON.stringify(item));
		expect(serialize(after.input).slice(0, before.input.length), `input prefix of request ${n + 1}`).toEqual(
			serialize(before.input),
		);
	}
}

describe("OpenAI Responses prefix stability across turns", () => {
	it("keeps request N as a byte prefix of N+1 on an explicit-mode model with effort changes", async () => {
		const model = getBuiltinModel("openai", "gpt-6-luna");
		const payloads = await runConversation(model, true);
		expectStablePrefix(payloads);

		const last = payloads.at(-1)!;
		// Leading tools go in place as additional_tools, then the instructions carry the two explicit
		// breakpoints; with the implicit breakpoint that makes three of the four writes.
		for (const payload of payloads) {
			expect(payload.input[0].type).toBe("additional_tools");
			expect(breakpoints(payload)).toEqual([
				{ index: 1, ttl: "12h" },
				{ index: 1, ttl: "12h" },
			]);
			expect(payload.input[1].role).toBe("developer");
			expect(payload.reasoning?.effort).toBe("medium");
		}
		// The foreign reply keeps its positional fallback id and loses its signed thinking.
		expect(last.input.filter((item) => item.type === "message").map((item) => item.id)).toEqual([
			"msg_pi_1",
			"msg_2",
			"msg_3",
		]);
		expect(JSON.stringify(last.input)).not.toContain("foreign-signature");
		// Encrypted reasoning is replayed verbatim.
		expect(last.input.filter((item) => item.type === "reasoning")).toEqual([reasoning("rs_1"), reasoning("rs_2")]);
		// Every tool declaration is in place, so the added tool never changes the request tool list.
		expect(last.tools).toBeUndefined();
		expect(last.input.filter((item) => item.type === "additional_tools")).toHaveLength(2);
		expect(last.input.filter((item) => item.type === "configuration_update").map((item) => item.reasoning)).toEqual([
			{ effort: "high" },
			{ effort: "low" },
			{ effort: "low" },
			{ effort: "low" },
		]);
	});

	it.each(["gpt-6-sol", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4"] as const)(
		"keeps the prefix stable on %s with a constant effort",
		async (id) => {
			const model = getBuiltinModel("openai", id);
			const payloads = await runConversation(model, false);
			expectStablePrefix(payloads);
			const explicit = model.compat?.supportsExplicitPromptCacheMode === true;
			for (const payload of payloads) {
				expect(breakpoints(payload)).toHaveLength(explicit ? 2 : 0);
				expect(payload.prompt_cache_options).toBeUndefined();
				expect(payload.prompt_cache_key).toBe("session-1");
			}
		},
	);
});
