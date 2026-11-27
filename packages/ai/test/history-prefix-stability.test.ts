/**
 * A provider can read the history from its cache only when the next request starts with the bytes of the previous one.
 * cache-contract.test.ts holds tools and instructions to that; this holds the history: each adapter must serialize a
 * transcript that only grew (a tool loop, a new user turn) as the previous request's messages plus new ones, apart from
 * where the breakpoints sit. After a compaction the history changes, but tools and instructions must not.
 */
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type Payload = Record<string, any>;
class Captured extends Error {}

interface Row {
	name: string;
	model: () => Model<any>;
	apiKey: string;
	/** The request's messages, in order. */
	history: (payload: Payload) => unknown[];
	/** Everything cached ahead of the history. */
	head: (payload: Payload) => unknown;
}

const ROWS: Row[] = [
	{
		name: "Anthropic Messages",
		model: () => getBuiltinModel("anthropic", "claude-haiku-4-5"),
		apiKey: "sk-ant-api-test",
		history: (payload) => payload.messages,
		head: (payload) => [payload.tools, payload.system],
	},
	{
		name: "Bedrock Converse",
		model: () => getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"),
		apiKey: "unused",
		history: (payload) => payload.messages,
		head: (payload) => [payload.toolConfig, payload.system],
	},
	{
		name: "OpenAI Responses (explicit cache)",
		model: () => getBuiltinModel("openai", "gpt-6-luna"),
		apiKey: "sk-test",
		history: (payload) => payload.input.slice(1),
		head: (payload) => [payload.tools, payload.input[0], payload.instructions],
	},
	{
		name: "OpenAI Chat Completions (OpenRouter Claude, with markers)",
		model: () => getBuiltinModel("openrouter", "anthropic/claude-fable-5.1:batch"),
		apiKey: "test-key",
		history: (payload) => payload.messages.slice(1),
		head: (payload) => [payload.tools, payload.messages[0]],
	},
	{
		name: "OpenAI Responses (legacy, implicit cache)",
		model: () => getBuiltinModel("openai", "gpt-4o-mini"),
		apiKey: "sk-test",
		history: (payload) => payload.input.slice(1),
		head: (payload) => [payload.tools, payload.input[0], payload.instructions],
	},
];

const TOOLS = [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }];
const SECTIONS = { docs: "<docs>d</docs>", project_context: "<project>p</project>", cwd: "<cwd>/w</cwd>" };

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

async function capture(row: Row, messages: Message[]): Promise<Payload> {
	let payload: Payload | undefined;
	const result = await streamSimple(
		row.model(),
		normalizeContext({
			systemPrompt: Object.values(SECTIONS).join(""),
			systemPromptSections: SECTIONS,
			messages,
			tools: TOOLS,
		} as never),
		{
			apiKey: row.apiKey,
			sessionId: "prefix-session",
			maxRetries: 0,
			cacheRetention: "long",
			instructionCacheBoundary: "project_context",
			fetch: async () => Promise.reject(new Error("network is forbidden")),
			onPayload: (value) => {
				payload = structuredClone(value) as Payload;
				throw new Captured();
			},
		},
	).result();
	if (!payload) throw new Error(`${row.name}: payload not captured: ${result.errorMessage}`);
	return payload;
}

const MARKER_KEYS = new Set(["cache_control", "prompt_cache_breakpoint"]);

/** The payload without its breakpoints, which move to the newest message on every request by design. */
function withoutBreakpoints(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value
			.filter((item) => !(item && typeof item === "object" && Object.keys(item).join() === "cachePoint"))
			.map(withoutBreakpoints);
	}
	if (!value || typeof value !== "object") return value;
	const entries = Object.entries(value).filter(([key]) => !MARKER_KEYS.has(key));
	const result = Object.fromEntries(entries.map(([key, child]) => [key, withoutBreakpoints(child)]));
	// A marked string message goes out as one text block; the provider renders both the same.
	if (typeof result.content === "string" && "role" in result) result.content = [{ type: "text", text: result.content }];
	return result;
}

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

describe.each(ROWS)("history prefix: $name", (row) => {
	const model = row.model();
	const turn1: Message[] = [{ role: "user", content: "Read a.ts", timestamp: 0 }, ...call(model, "call_a", "a.ts")];
	const turn2: Message[] = [...turn1, ...call(model, "call_b", "b.ts")];
	const turn3: Message[] = [
		...turn2,
		reply(model, [{ type: "text", text: "Both read." }], "stop"),
		{ role: "user", content: "Next.", timestamp: 3 },
	];

	it("serializes each request as the previous one's messages plus the new ones", async () => {
		const requests = await Promise.all([turn1, turn2, turn3].map((messages) => capture(row, messages)));
		const [head, ...laterHeads] = requests.map((payload) => JSON.stringify(row.head(payload)));
		for (const later of laterHeads) expect(later).toBe(head);
		for (let i = 1; i < requests.length; i++) {
			const previous = withoutBreakpoints(row.history(requests[i - 1])) as unknown[];
			const next = withoutBreakpoints(row.history(requests[i])) as unknown[];
			expect(next.length).toBeGreaterThan(previous.length);
			expect(JSON.stringify(next.slice(0, previous.length))).toBe(JSON.stringify(previous));
		}
	});

	it("keeps tools and instructions byte-identical after a compaction replaces the history", async () => {
		const before = await capture(row, turn3);
		const compacted: Message[] = [
			{ role: "user", content: "Summary of the conversation so far: read a.ts and b.ts.", timestamp: 4 },
			{ role: "user", content: "Next.", timestamp: 5 },
		];
		const after = await capture(row, compacted);
		expect(JSON.stringify(row.head(after))).toBe(JSON.stringify(row.head(before)));
	});
});
