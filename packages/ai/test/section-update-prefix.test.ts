/**
 * A mid-session system-section update (a new day changes only `environment`) must reach the model after the history it
 * already cached: the request that carries it starts with the bytes of the request before it, apart from where the
 * breakpoints sit. Recorded usage showed the whole history re-written at such an update; this pins the adapters'
 * share of that contract, with the real payload builders and no network. The coding-agent side (the request hook that
 * rebuilds the transcript before it gets here) is pinned in the coding-agent section-update-cache test.
 */
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Message, Model, SystemMessage } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type Payload = Record<string, any>;
class Captured extends Error {}

const TOOLS = [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }];
const SECTIONS = {
	preamble: "<preamble>p</preamble>",
	tools: "<tools>t</tools>",
	project_context: "<project>project text</project>",
	skills: "<skills>s</skills>",
	environment: "<environment>Date: 2026-11-07</environment>",
};
const BOUNDARY = "project_context";

function head(): SystemMessage {
	return { role: "system", content: "", sections: SECTIONS, toolsAdded: TOOLS, timestamp: 0 };
}

function update(sections: Record<string, string | null>): SystemMessage {
	return { role: "system", content: "", sections, timestamp: 9 };
}

function reply(model: Model<any>, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) {
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
		timestamp: 1,
	} satisfies AssistantMessage;
}

function call(model: Model<any>, id: string, path: string): Message[] {
	return [
		reply(model, [{ type: "toolCall", id, name: "read", arguments: { path } }], "toolUse"),
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: `${path} body` }],
			isError: false,
			timestamp: 2,
		},
	];
}

async function capture(model: Model<any>, apiKey: string, messages: Message[]): Promise<Payload> {
	let payload: Payload | undefined;
	const result = await streamSimple(model, normalizeContext({ messages }), {
		apiKey,
		sessionId: "update-session",
		maxRetries: 0,
		cacheRetention: "long",
		instructionCacheBoundary: BOUNDARY,
		fetch: async () => Promise.reject(new Error("network is forbidden")),
		onPayload: (value) => {
			payload = structuredClone(value) as Payload;
			throw new Captured();
		},
	}).result();
	if (!payload) throw new Error(`payload not captured: ${result.errorMessage}`);
	return payload;
}

const MARKER_KEYS = new Set(["cache_control", "prompt_cache_breakpoint"]);

/** The payload without its breakpoints, which move to the newest message on every request by design. */
function withoutBreakpoints(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutBreakpoints);
	if (!value || typeof value !== "object") return value;
	const entries = Object.entries(value).filter(([key]) => !MARKER_KEYS.has(key));
	const result = Object.fromEntries(entries.map(([key, child]) => [key, withoutBreakpoints(child)]));
	// A marked string message goes out as one text block; the provider renders both the same.
	if (typeof result.content === "string" && "role" in result) result.content = [{ type: "text", text: result.content }];
	return result;
}

/** Message indexes whose last block carries a breakpoint (Anthropic). */
function markedMessages(payload: Payload): number[] {
	return (payload.messages as Payload[]).flatMap((message, index) => {
		const blocks = Array.isArray(message.content) ? message.content : [];
		return blocks.some((block: Payload) => block.cache_control) ? [index] : [];
	});
}

interface Row {
	name: string;
	model: () => Model<any>;
	apiKey: string;
	history: (payload: Payload) => unknown[];
	head: (payload: Payload) => unknown;
}

const midConvo = (): Model<any> => ({
	...getBuiltinModel("anthropic", "claude-haiku-4-5"),
	compat: { supportsMidConvoSystemMessages: true },
});

const ROWS: Row[] = [
	{
		name: "Anthropic Messages (updates collapse into user turns)",
		model: () => getBuiltinModel("anthropic", "claude-haiku-4-5"),
		apiKey: "sk-ant-api-test",
		history: (payload) => payload.messages,
		head: (payload) => [payload.tools, payload.system],
	},
	{
		name: "Anthropic Messages (native mid-conversation system messages)",
		model: midConvo,
		apiKey: "sk-ant-api-test",
		history: (payload) => payload.messages,
		head: (payload) => [payload.tools, payload.system],
	},
	{
		name: "OpenAI Responses (explicit cache)",
		model: () => getBuiltinModel("openai", "gpt-6-luna"),
		apiKey: "sk-test",
		history: (payload) => payload.input.slice(1),
		head: (payload) => [payload.tools, payload.input[0], payload.instructions],
	},
	{
		name: "OpenAI Responses (legacy, implicit cache)",
		model: () => getBuiltinModel("openai", "gpt-4o-mini"),
		apiKey: "sk-test",
		history: (payload) => payload.input.slice(1),
		head: (payload) => [payload.tools, payload.input[0], payload.instructions],
	},
];

beforeEach(() => {
	for (const name of [
		"OCTOCODE_CACHE_RETENTION",
		"OCTOCODE_INSTRUCTION_CACHE_RETENTION",
		"OCTOCODE_PROMPT_CACHE_KEY",
	]) {
		vi.stubEnv(name, undefined);
	}
});
afterEach(() => vi.unstubAllEnvs());

describe.each(ROWS)("section update: $name", (row) => {
	const model = row.model();
	const turn: Message[] = [{ role: "user", content: "Read a.ts", timestamp: 0 }, ...call(model, "call_a", "a.ts")];
	const today = update({ environment: "<environment>Date: 2026-11-08</environment>" });
	const next: Message[] = [{ role: "user", content: "Next.", timestamp: 3 }];
	const answered: Message[] = [...turn, reply(model, [{ type: "text", text: "Done." }], "stop")];

	it("keeps the head and every earlier message byte-identical when an update precedes the next user turn", async () => {
		const before = await capture(model, row.apiKey, [head(), ...answered]);
		const after = await capture(model, row.apiKey, [head(), ...answered, today, ...next]);
		expect(JSON.stringify(row.head(after))).toBe(JSON.stringify(row.head(before)));
		const previous = withoutBreakpoints(row.history(before)) as unknown[];
		const later = withoutBreakpoints(row.history(after)) as unknown[];
		expect(later.length).toBeGreaterThan(previous.length);
		expect(JSON.stringify(later.slice(0, previous.length))).toBe(JSON.stringify(previous));
		expect(JSON.stringify(later)).toContain("Date: 2026-11-08");
	});

	it("keeps them when the update lands in a tool loop, after a tool result", async () => {
		const before = await capture(model, row.apiKey, [head(), ...turn]);
		const after = await capture(model, row.apiKey, [head(), ...turn, today]);
		expect(JSON.stringify(row.head(after))).toBe(JSON.stringify(row.head(before)));
		const previous = withoutBreakpoints(row.history(before)) as unknown[];
		const later = withoutBreakpoints(row.history(after)) as unknown[];
		expect(JSON.stringify(later.slice(0, previous.length))).toBe(JSON.stringify(previous));
	});
});

describe("section update: Anthropic breakpoints", () => {
	it.each([
		["collapsing", () => getBuiltinModel("anthropic", "claude-haiku-4-5")],
		["native system messages", midConvo],
	])("keeps both instruction breakpoints and the history marker on the cached tail (%s)", async (_name, makeModel) => {
		const model = makeModel();
		const turn: Message[] = [{ role: "user", content: "Read a.ts", timestamp: 0 }, ...call(model, "call_a", "a.ts")];
		const answered: Message[] = [...turn, reply(model, [{ type: "text", text: "Done." }], "stop")];
		const before = await capture(model, "sk-ant-api-test", [head(), ...turn]);
		const after = await capture(model, "sk-ant-api-test", [
			head(),
			...answered,
			update({ environment: "<environment>Date: 2026-11-08</environment>" }),
			{ role: "user", content: "Next.", timestamp: 3 },
		]);
		expect((before.system as Payload[]).map((block) => Boolean(block.cache_control))).toEqual([true, true]);
		expect((after.system as Payload[]).map((block) => Boolean(block.cache_control))).toEqual([true, true]);
		// The previous request's tail (its last message, the tool result) stays reachable by a breakpoint.
		const tail = (before.messages as unknown[]).length - 1;
		expect(markedMessages(before)).toContain(tail);
		expect(markedMessages(after)).toContain(tail);
		// The newest message carries the history marker, and nothing is marked after it.
		expect(Math.max(...markedMessages(after))).toBe((after.messages as unknown[]).length - 1);
	});
});
