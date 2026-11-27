/**
 * Provider cache contract: a cached prefix is only reused when every adapter sends the bytes and breakpoints the
 * retention settings promise, so this holds all adapters to one table.
 *
 * One fixture runs through every adapter that sends cache controls, and through the implicit ones for contrast. For
 * each row it asserts, with the retention table of packages/coding-agent/docs/prompt-caching.md as the oracle:
 *  (i)   two requests with different histories serialize byte-identical tools and instruction blocks;
 *  (ii)  the breakpoints and their lifetimes match each cacheRetention / instructionCacheRetention pair;
 *  (iii) the routing key is present, or absent when caching is off (always absent on implicit adapters).
 * The per-adapter *cache* tests stay: they cover wire details this table does not.
 */
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, CacheRetention, Message, Model, StreamOptions, SystemMessage } from "../src/types.ts";
import { normalizeContext, type TranscriptContext } from "../src/utils/transcript.ts";

type Zone = "tools" | "instructions" | "history";
type Payload = Record<string, any>;

interface Row {
	name: string;
	model: () => Model<any>;
	apiKey: string;
	/** Implicit adapters send no cache field; the table asserts that too. */
	implicit?: boolean;
	/** Wire field that carries the routing key; omit for adapters that send none. */
	routingKeyField?: string;
	/** Lowest history retention at which the routing key goes out. Default: any but `none`. */
	routingKeyFrom?: "long";
	/** Expected breakpoints (`zone:ttl`, in tools, instructions, history order) for a pair: the doc's retention table. */
	marks?: (history: CacheRetention, instructions: CacheRetention) => string[];
	tools: (payload: Payload) => unknown;
	instructions: (payload: Payload) => unknown;
}

const SECTIONS = { docs: "<docs>d</docs>", project_context: "<project>p</project>", cwd: "<cwd>/w</cwd>" };
const TOOLS = [
	{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
	{ name: "search", description: "Search files", parameters: Type.Object({ query: Type.String() }) },
];
const LEVELS = ["none", "short", "long"] as const;
const PAIRS = LEVELS.flatMap((history) =>
	LEVELS.map((instructions): [CacheRetention, CacheRetention] => [history, instructions]),
);

function assistantCall(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call12345", name: "read", arguments: { path: "a.ts" } }],
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
		stopReason: "toolUse",
		timestamp: 2,
	};
}

/** The same instructions and tools over a short and a long history. */
function histories(model: Model<any>): [TranscriptContext, TranscriptContext] {
	const build = (messages: Message[]): TranscriptContext => {
		const base = normalizeContext({ systemPrompt: "unused", messages, tools: TOOLS });
		const [initial, ...rest] = base.messages;
		const head: SystemMessage = { role: "system", content: "Base prompt", sections: SECTIONS, timestamp: 0 };
		return { messages: [{ ...(initial as SystemMessage), ...head }, ...rest] } as TranscriptContext;
	};
	return [
		build([{ role: "user", content: "First task", timestamp: 1 }]),
		build([
			{ role: "user", content: "First task", timestamp: 1 },
			assistantCall(model),
			{
				role: "toolResult",
				toolCallId: "call12345",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user", content: "A different follow-up task", timestamp: 4 },
		]),
	];
}

class Captured extends Error {}

async function capture(row: Row, context: TranscriptContext, options: StreamOptions): Promise<Payload> {
	let payload: Payload | undefined;
	const result = await streamSimple(row.model(), context, {
		apiKey: row.apiKey,
		sessionId: "contract-session",
		maxRetries: 0,
		instructionCacheBoundary: "project_context",
		// The Google adapters reject a custom fetch; their payload hook fires before any request.
		...(row.implicit ? {} : { fetch: async () => Promise.reject(new Error("network is forbidden")) }),
		...options,
		onPayload: (value) => {
			payload = value as Payload;
			throw new Captured();
		},
	}).result();
	if (!payload) throw new Error(`${row.name}: payload not captured: ${result.errorMessage}`);
	return payload;
}

const TTL_BY_KEY: Record<string, (value: { ttl?: string }) => string> = {
	cache_control: (value) => value.ttl ?? "5m",
	cachePoint: (value) => value.ttl ?? "5m",
	prompt_cache_breakpoint: (value) => value.ttl ?? "?",
};

/** Every breakpoint object in the payload as `zone:ttl`, ordered tools, instructions, history. */
function breakpoints(payload: Payload): string[] {
	const found: Record<Zone, string[]> = { tools: [], instructions: [], history: [] };
	const walk = (node: unknown, zone: Zone): void => {
		if (Array.isArray(node)) {
			for (const item of node as { role?: string; type?: string }[]) {
				const role = item?.role;
				const itemZone: Zone =
					item?.type === "additional_tools"
						? "tools"
						: role === "system" || role === "developer"
							? "instructions"
							: role
								? "history"
								: zone;
				walk(item, itemZone);
			}
			return;
		}
		if (!node || typeof node !== "object") return;
		for (const [key, value] of Object.entries(node)) {
			const ttl = TTL_BY_KEY[key];
			if (ttl && value && typeof value === "object") found[zone].push(`${zone}:${ttl(value)}`);
			else if (key === "tools" || key === "toolConfig") walk(value, "tools");
			else if (key === "system" || key === "instructions") walk(value, "instructions");
			else walk(value, zone);
		}
	};
	walk(payload, "history");
	return [...found.tools, ...found.instructions, ...found.history];
}

/**
 * The doc's "Retention per layer" row for Anthropic, Bedrock Claude and OpenRouter Claude: the instruction retention on
 * both instruction blocks (the tools marker folds into the first), the history retention on the last history block.
 * A 1h entry must precede 5m ones, so long history behind short instructions is sent at 5m.
 */
function anthropicFormat(history: CacheRetention, instructions: CacheRetention): string[] {
	if (history === "none") return [];
	const instructionTtl = instructions === "long" ? "1h" : "5m";
	const historyTtl = history === "long" && instructions !== "short" ? "1h" : "5m";
	return [
		...(instructions === "none" ? [] : [`instructions:${instructionTtl}`, `instructions:${instructionTtl}`]),
		`history:${historyTtl}`,
	];
}

/** OpenAI explicit mode (GPT-5.6 and later): 12h or 30m on both instruction blocks; history is implicit. */
function openaiExplicit(history: CacheRetention, instructions: CacheRetention): string[] {
	if (history === "none" || instructions === "none") return [];
	const ttl = instructions === "long" ? "12h" : "30m";
	return [`instructions:${ttl}`, `instructions:${ttl}`];
}

const noBreakpoints = (): string[] => [];
const input = (payload: Payload): unknown[] => payload.input ?? [];
const leading = (messages: unknown[]): unknown[] =>
	messages.filter((message) => ["system", "developer"].includes((message as { role?: string }).role ?? ""));
const responsesTools = (payload: Payload): unknown =>
	payload.tools ?? input(payload).filter((item) => (item as { type?: string }).type === "additional_tools");

const ROWS: Row[] = [
	{
		name: "anthropic-messages (Anthropic)",
		model: () => getBuiltinModel("anthropic", "claude-haiku-4-5"),
		apiKey: "sk-ant-api-test",
		marks: anthropicFormat,
		tools: (payload) => payload.tools,
		instructions: (payload) => payload.system,
	},
	{
		name: "bedrock-converse-stream (Claude)",
		model: () => getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"),
		apiKey: "unused",
		marks: anthropicFormat,
		tools: (payload) => payload.toolConfig,
		instructions: (payload) => payload.system,
	},
	{
		name: "openai-completions (OpenRouter Claude)",
		model: () => getBuiltinModel("openrouter", "anthropic/claude-fable-5.1:batch"),
		apiKey: "test-key",
		routingKeyField: "prompt_cache_key",
		routingKeyFrom: "long",
		marks: anthropicFormat,
		tools: (payload) => payload.tools,
		instructions: (payload) => leading(payload.messages),
	},
	{
		name: "openai-responses (explicit mode)",
		model: () => getBuiltinModel("openai", "gpt-6-luna"),
		apiKey: "sk-test",
		routingKeyField: "prompt_cache_key",
		marks: openaiExplicit,
		tools: responsesTools,
		instructions: (payload) => leading(input(payload)),
	},
	{
		name: "openai-responses (legacy OpenAI)",
		model: () => getBuiltinModel("openai", "gpt-4o-mini"),
		apiKey: "sk-test",
		routingKeyField: "prompt_cache_key",
		marks: noBreakpoints,
		tools: responsesTools,
		instructions: (payload) => leading(input(payload)),
	},
	{
		name: "openai-responses (xAI Grok)",
		model: () => getBuiltinModel("xai", "grok-4.3"),
		apiKey: "xai-test",
		routingKeyField: "prompt_cache_key",
		marks: noBreakpoints,
		tools: responsesTools,
		instructions: (payload) => leading(input(payload)),
	},
	{
		name: "azure-openai-responses",
		model: () => ({
			id: "test-deployment",
			name: "Test Deployment",
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: "http://127.0.0.1:9/openai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		}),
		apiKey: "test-key",
		routingKeyField: "prompt_cache_key",
		marks: noBreakpoints,
		tools: responsesTools,
		instructions: (payload) => leading(input(payload)),
	},
	{
		name: "mistral-conversations",
		model: () => getBuiltinModel("mistral", "codestral-latest"),
		apiKey: "test-key",
		routingKeyField: "prompt_cache_key",
		marks: noBreakpoints,
		tools: (payload) => payload.tools,
		instructions: (payload) => leading(payload.messages),
	},
	{
		name: "google-generative-ai (implicit)",
		model: () => getBuiltinModel("google", "gemini-2.5-pro"),
		apiKey: "test-key",
		implicit: true,
		tools: (payload) => payload.tools,
		instructions: (payload) => payload.systemInstruction,
	},
	{
		name: "google-vertex (implicit)",
		model: () => getBuiltinModel("google-vertex", "gemini-2.5-pro"),
		apiKey: "test-key",
		implicit: true,
		tools: (payload) => payload.tools,
		instructions: (payload) => payload.systemInstruction,
	},
	{
		name: "cloudflare-workers-ai (implicit)",
		model: () => getBuiltinModel("cloudflare-workers-ai", "@cf/deepseek-ai/deepseek-v4-flash-0731"),
		apiKey: "test-key",
		implicit: true,
		tools: (payload) => payload.tools,
		instructions: (payload) => leading(payload.messages),
	},
];

beforeEach(() => {
	// The caller's retention preferences would change the lifetimes asserted below.
	for (const name of [
		"OCTOCODE_CACHE_RETENTION",
		"OCTOCODE_INSTRUCTION_CACHE_RETENTION",
		"OCTOCODE_PROMPT_CACHE_KEY",
	]) {
		vi.stubEnv(name, undefined);
	}
});
afterEach(() => vi.unstubAllEnvs());

describe.each(ROWS)("cache contract: $name", (row) => {
	describe("(i) the prefix does not depend on history", () => {
		it.each(PAIRS)(
			"tools and instructions are byte-identical for history=%s instructions=%s",
			async (history, instructions) => {
				const [short, long] = histories(row.model());
				const options = { cacheRetention: history, instructionCacheRetention: instructions };
				const a = await capture(row, short, options);
				const b = await capture(row, long, options);
				const tools = JSON.stringify(row.tools(a));
				const blocks = JSON.stringify(row.instructions(a));
				expect(tools, "the adapter must declare tools").toBeTruthy();
				expect(blocks, "the adapter must send the leading instructions").toBeTruthy();
				expect(JSON.stringify(row.tools(b))).toBe(tools);
				expect(JSON.stringify(row.instructions(b))).toBe(blocks);
			},
		);
	});

	if (row.implicit) {
		it.each(PAIRS)("(ii, iii) sends no cache field for history=%s instructions=%s", async (history, instructions) => {
			const payload = await capture(row, histories(row.model())[0], {
				cacheRetention: history,
				instructionCacheRetention: instructions,
			});
			expect(breakpoints(payload)).toEqual([]);
			expect(JSON.stringify(payload)).not.toMatch(/cache/i);
		});
		return;
	}

	describe("(ii) breakpoints and retention", () => {
		it.each(PAIRS)("history=%s instructions=%s", async (history, instructions) => {
			const payload = await capture(row, histories(row.model())[0], {
				cacheRetention: history,
				instructionCacheRetention: instructions,
			});
			expect(breakpoints(payload)).toEqual(row.marks!(history, instructions));
		});
	});

	describe("(iii) routing key", () => {
		it.each(LEVELS)("history=%s", async (history) => {
			const payload = await capture(row, histories(row.model())[0], {
				cacheRetention: history,
				instructionCacheRetention: history,
			});
			if (!row.routingKeyField) {
				// Anthropic-protocol adapters route by breakpoint prefix and carry no key.
				expect(JSON.stringify(payload)).not.toMatch(/prompt_?cache_?key|contract-session/i);
				return;
			}
			const present = history !== "none" && (row.routingKeyFrom !== "long" || history === "long");
			expect(payload[row.routingKeyField]).toBe(present ? "contract-session" : undefined);
		});
	});
});
