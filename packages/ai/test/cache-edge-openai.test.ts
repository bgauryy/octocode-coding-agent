/**
 * Cache edge cases on the OpenAI-family, Google, Mistral and xAI routes that the shared prefix tests
 * (history-prefix-stability, section-update-prefix, openai-responses-prefix-stability) do not run:
 * Codex Responses, Azure Responses, xAI Responses, plain Chat Completions providers and the Google adapters.
 *
 * OpenAI, xAI, DeepSeek, Groq and Google all cache an exact request prefix, so every request must start with the
 * previous request's bytes: tools, instructions and history in place, a mid-session section update appended after the
 * history, the routing key and the prefix-shaping fields (parallel_tool_calls, text, reasoning) unchanged.
 * The payload describer must also see the cache fields each API sets.
 */
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import { resolveModelCapabilities } from "../src/models/capabilities.ts";
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "../src/providers/all.ts";
import type { AssistantMessage, Message, Model, SystemMessage } from "../src/types.ts";
import { describePayloadLayers } from "../src/utils/payload-layers.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type Payload = Record<string, any>;
class Captured extends Error {}

const TOOLS = [
	{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
	{ name: "search", description: "Search", parameters: Type.Object({ query: Type.String(), limit: Type.Number() }) },
];
const SECTIONS = {
	preamble: "<preamble>p</preamble>",
	project_context: "<project>project text</project>",
	environment: "<environment>Date: 2026-11-07</environment>",
};
const codexToken = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.b`;

function head(): SystemMessage {
	return { role: "system", content: "", sections: SECTIONS, toolsAdded: TOOLS, timestamp: 0 };
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

interface Row {
	name: string;
	model: () => Model<any>;
	apiKey: string;
	/** The Google adapters reject a custom fetch; their payload hook fires before any request. */
	noFetch?: boolean;
	/** Tools and instructions: everything before the first conversation item. */
	head: (payload: Payload) => unknown;
	history: (payload: Payload) => unknown[];
	/** Top-level fields that are part of the cached prefix on this route. */
	prefixFields: string[];
}

const LEADING = new Set(["system", "developer"]);
/** Index of the first conversation item: leading instructions and in-place tool declarations come before it. */
const firstTurn = (items: Payload[]): number =>
	items.findIndex((item) => !LEADING.has(item.role) && item.type !== "additional_tools");
const responsesHead = (payload: Payload) => [
	payload.tools,
	payload.instructions,
	payload.input.slice(0, firstTurn(payload.input)),
];
const responsesHistory = (payload: Payload) => payload.input.slice(firstTurn(payload.input));
const completionsHead = (payload: Payload) => [payload.tools, payload.messages.slice(0, firstTurn(payload.messages))];
const completionsHistory = (payload: Payload) => payload.messages.slice(firstTurn(payload.messages));
const googleHead = (payload: Payload, wire = false) =>
	wire ? [payload.tools, payload.systemInstruction] : [payload.config?.tools, payload.config?.systemInstruction];
const googleHistory = (payload: Payload) => payload.contents;

const azureModel = (): Model<"azure-openai-responses"> => ({
	id: "test-deployment",
	name: "Test Deployment",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "http://127.0.0.1:9/openai/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
});

const RESPONSES_FIELDS = ["model", "tools", "tool_choice", "parallel_tool_calls", "text", "prompt_cache_key"];
const ROWS: Row[] = [
	{
		name: "openai-codex-responses",
		model: () => getBuiltinModel("openai-codex", "gpt-5.5"),
		apiKey: codexToken,
		head: (payload) => [payload.tools, payload.instructions],
		history: (payload) => payload.input,
		prefixFields: [...RESPONSES_FIELDS, "instructions"],
	},
	{
		name: "azure-openai-responses",
		model: azureModel,
		apiKey: "test-key",
		head: responsesHead,
		history: responsesHistory,
		prefixFields: RESPONSES_FIELDS,
	},
	{
		name: "openai-responses (xAI Grok)",
		model: () => getBuiltinModel("xai", "grok-4.3"),
		apiKey: "xai-test",
		head: responsesHead,
		history: responsesHistory,
		prefixFields: RESPONSES_FIELDS,
	},
	{
		name: "openai-completions (DeepSeek)",
		model: () => getBuiltinModel("deepseek", "deepseek-v4-pro"),
		apiKey: "test-key",
		head: completionsHead,
		history: completionsHistory,
		prefixFields: ["model", "tools", "tool_choice", "parallel_tool_calls", "prompt_cache_key"],
	},
	{
		name: "openai-completions (Groq)",
		model: () => getBuiltinModel("groq", "openai/gpt-oss-120b"),
		apiKey: "test-key",
		head: completionsHead,
		history: completionsHistory,
		prefixFields: ["model", "tools", "tool_choice", "parallel_tool_calls", "prompt_cache_key"],
	},
	{
		name: "google-generative-ai",
		model: () => getBuiltinModel("google", "gemini-2.5-pro"),
		apiKey: "test-key",
		noFetch: true,
		head: (payload) => googleHead(payload, true),
		history: googleHistory,
		prefixFields: ["model"],
	},
	{
		name: "google-vertex",
		model: () => getBuiltinModel("google-vertex", "gemini-2.5-pro"),
		apiKey: "test-key",
		noFetch: true,
		head: (payload) => googleHead(payload, true),
		history: googleHistory,
		prefixFields: ["model"],
	},
];

async function capture(row: Row, messages: Message[], extra: Record<string, unknown> = {}): Promise<Payload> {
	let payload: Payload | undefined;
	const result = await streamSimple(row.model(), normalizeContext({ messages }), {
		apiKey: row.apiKey,
		sessionId: "edge-session",
		maxRetries: 0,
		cacheRetention: "long",
		instructionCacheBoundary: "project_context",
		...(row.noFetch ? {} : { fetch: async () => Promise.reject(new Error("network is forbidden")) }),
		...extra,
		onPayload: (value) => {
			payload = structuredClone(value) as Payload;
			throw new Captured();
		},
	}).result();
	if (!payload) throw new Error(`${row.name}: payload not captured: ${result.errorMessage}`);
	return payload;
}

const MARKER_KEYS = new Set(["cache_control", "prompt_cache_breakpoint"]);

/** The payload without breakpoints, which move to the newest message on every request by design. */
function withoutBreakpoints(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutBreakpoints);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !MARKER_KEYS.has(key))
			.map(([key, child]) => [key, withoutBreakpoints(child)]),
	);
}

function expectPrefix(row: Row, before: Payload, after: Payload): void {
	expect(JSON.stringify(row.head(after)), "tools and instructions").toBe(JSON.stringify(row.head(before)));
	for (const field of row.prefixFields) {
		expect(JSON.stringify(after[field]), field).toBe(JSON.stringify(before[field]));
	}
	expect(JSON.stringify(after.reasoning?.effort ?? after.config?.thinkingConfig)).toBe(
		JSON.stringify(before.reasoning?.effort ?? before.config?.thinkingConfig),
	);
	const previous = withoutBreakpoints(row.history(before)) as unknown[];
	const later = withoutBreakpoints(row.history(after)) as unknown[];
	expect(later.length).toBeGreaterThan(previous.length);
	expect(JSON.stringify(later.slice(0, previous.length)), "history prefix").toBe(JSON.stringify(previous));
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

describe.each(ROWS)("prefix edge cases: $name", (row) => {
	const model = row.model();
	const turn1: Message[] = [{ role: "user", content: "Read a.ts", timestamp: 0 }, ...call(model, "call_a", "a.ts")];
	const turn2: Message[] = [...turn1, ...call(model, "call_b", "b.ts")];
	const answered: Message[] = [...turn2, reply(model, [{ type: "text", text: "Both read." }], "stop")];
	const today: SystemMessage = {
		role: "system",
		content: "",
		sections: { environment: "<environment>Date: 2026-11-08</environment>" },
		timestamp: 9,
	};
	const next: Message[] = [{ role: "user", content: "Next.", timestamp: 3 }];

	it("serializes each tool-loop request as the previous one plus the new items", async () => {
		const first = await capture(row, [head(), ...turn1]);
		const second = await capture(row, [head(), ...turn2]);
		const third = await capture(row, [head(), ...answered, ...next]);
		expectPrefix(row, first, second);
		expectPrefix(row, second, third);
	});

	it("appends a section update after the cached history instead of rewriting the instructions", async () => {
		const before = await capture(row, [head(), ...answered]);
		const after = await capture(row, [head(), ...answered, today, ...next]);
		expectPrefix(row, before, after);
		expect(JSON.stringify(row.history(after))).toContain("Date: 2026-11-08");
	});

	it("keeps the prefix when the update lands in a tool loop, after a tool result", async () => {
		const before = await capture(row, [head(), ...turn1]);
		const after = await capture(row, [head(), ...turn1, today]);
		expectPrefix(row, before, after);
	});

	it("sends tools in declaration order with schema keys in declaration order", async () => {
		const payload = JSON.stringify(row.head(await capture(row, [head(), ...turn1])));
		expect(payload.indexOf('"read"')).toBeGreaterThan(-1);
		expect(payload.indexOf('"read"')).toBeLessThan(payload.indexOf('"search"'));
		expect(payload.indexOf('"query"')).toBeLessThan(payload.indexOf('"limit"'));
	});
});

/** The payload of one request, as the agent session hands it to the describer. */
async function rawPayload(
	model: Model<any>,
	apiKey: string,
	messages: Message[],
	extra: Record<string, unknown> = {},
): Promise<Payload> {
	return capture(
		{
			name: model.id,
			model: () => model,
			apiKey,
			noFetch: model.api === "google-generative-ai" || model.api === "google-vertex",
			head: () => [],
			history: () => [],
			prefixFields: [],
		},
		[head(), ...messages],
		extra,
	);
}

describe("payload describer on the routes that set cache fields", () => {
	const anthropic = () => getBuiltinModel("anthropic", "claude-haiku-4-5");
	const openRouterClaude = () => getBuiltinModel("openrouter", "anthropic/claude-fable-5.1:batch");
	const bedrock = () => getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
	const explicitOpenAi = () => getBuiltinModel("openai", "gpt-6-luna");
	const shapes = (trace: ReturnType<typeof describePayloadLayers>) =>
		trace?.layers.map(({ kind, role, breakpoint }) => [kind, role, breakpoint ?? false]);

	it.each([
		["anthropic-messages", anthropic, "sk-ant-api-test"],
		["openai-completions (OpenRouter Claude)", openRouterClaude, "test-key"],
		["bedrock-converse-stream", bedrock, "unused"],
		["openai-responses (explicit mode)", explicitOpenAi, "sk-test"],
	] as const)(
		"keeps every earlier layer's hash when the breakpoint moves to the new tail (%s)",
		async (_n, make, key) => {
			const model = make();
			const turn1: Message[] = [{ role: "user", content: "Read a.ts", timestamp: 0 }, ...call(model, "call_a", "a.ts")];
			const turn2: Message[] = [...turn1, ...call(model, "call_b", "b.ts")];
			const options = { instructionCacheRetention: "long" };
			const before = describePayloadLayers(model.api, await rawPayload(model, key, turn1, options));
			const after = describePayloadLayers(model.api, await rawPayload(model, key, turn2, options));
			expect(before, "the API needs a describer").toBeDefined();
			const changed = before!.layers.flatMap((layer, i) =>
				after!.layers[i]?.hash === layer.hash ? [] : [`${i}:${layer.kind}:${layer.role ?? ""}`],
			);
			expect(changed, "layers whose hash changed though the provider prefix did not").toEqual([]);
			expect(after!.layers.some((layer) => layer.breakpoint)).toBe(true);
		},
	);

	it("marks the explicit instruction breakpoints and the in-place tools on GPT-5.6+ Responses", async () => {
		const model = explicitOpenAi();
		const turn: Message[] = [{ role: "user", content: "hi", timestamp: 0 }];
		const long = describePayloadLayers(
			model.api,
			await rawPayload(model, "sk-test", turn, { cacheRetention: "long", instructionCacheRetention: "long" }),
		);
		expect(shapes(long)).toEqual([
			["tools", "developer", false],
			["system", "developer", true],
			["message", "user", false],
		]);
		expect(long?.cacheMode).toBe("key+12h+breakpoint-12h");
		const short = describePayloadLayers(
			model.api,
			await rawPayload(model, "sk-test", turn, { cacheRetention: "short", instructionCacheRetention: "short" }),
		);
		expect(short?.cacheMode).toBe("key+breakpoint-30m");
		const none = describePayloadLayers(
			model.api,
			await rawPayload(model, "sk-test", turn, { cacheRetention: "none", instructionCacheRetention: "long" }),
		);
		expect(none?.layers.some((layer) => layer.breakpoint)).toBe(false);
		expect(none?.cacheMode).toBe("explicit");
	});

	it("marks Anthropic-style markers on Chat Completions (OpenRouter Claude)", async () => {
		const model = openRouterClaude();
		const trace = describePayloadLayers(
			model.api,
			await rawPayload(model, "test-key", [{ role: "user", content: "hi", timestamp: 0 }], {
				instructionCacheRetention: "long",
			}),
		);
		// The tools marker folds into the first of the two instruction blocks, which follow the tools.
		expect(shapes(trace)).toEqual([
			["tools", undefined, false],
			["system", "developer", true],
			["message", "user", true],
		]);
		expect(trace?.cacheMode).toBe("key+ephemeral-1h");
	});

	it("describes Bedrock Converse with its cache points as breakpoints, not layers", async () => {
		const model = bedrock();
		const trace = describePayloadLayers(
			model.api,
			await rawPayload(model, "unused", [{ role: "user", content: "hi", timestamp: 0 }], {
				instructionCacheRetention: "long",
			}),
		);
		expect(shapes(trace)).toEqual([
			["tools", undefined, false],
			["system", undefined, true],
			["system", undefined, true],
			["message", "user", true],
		]);
		expect(trace?.cacheMode).toBe("default-1h");
	});

	it("describes Mistral conversations and reads its routing key", async () => {
		const model = getBuiltinModel("mistral", "codestral-latest");
		const trace = describePayloadLayers(
			model.api,
			await rawPayload(model, "test-key", [{ role: "user", content: "hi", timestamp: 0 }]),
		);
		expect(shapes(trace)).toEqual([
			["tools", undefined, false],
			["system", "system", false],
			["message", "user", false],
		]);
		expect(trace?.cacheMode).toBe("key");
	});
});

/**
 * Longest documented tier per route under the default settings (long instructions, long history):
 * https://developers.openai.com/api/docs/guides/prompt-caching (GPT-5.6 and later: explicit mode, `ttl` 30m or 12h in
 * Responses; the extended-retention footnote lists the models that take `prompt_cache_retention: "24h"`) and
 * https://learn.microsoft.com/azure/foundry/openai/how-to/prompt-caching (Azure's own 24h list).
 */
const OPENAI_EXTENDED_RETENTION = new Set([
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.4",
	"gpt-5.2",
	"gpt-5.1-codex-max",
	"gpt-5.1",
	"gpt-5.1-codex",
	"gpt-5.1-codex-mini",
	"gpt-5.1-chat-latest",
	"gpt-5",
	"gpt-5-codex",
	"gpt-4.1",
]);
const AZURE_EXTENDED_RETENTION = new Set([
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.3-codex",
	"gpt-5.2",
	"gpt-5.1-codex-max",
	"gpt-5.1",
	"gpt-5.1-codex",
	"gpt-5.1-codex-mini",
	"gpt-5.1-chat",
	"gpt-5",
	"gpt-5-codex",
	"gpt-4.1",
]);

/** GPT-5.6 and later by family version; the daybreak aliases are listed explicit-mode models without a version. */
function isExplicitGeneration(id: string): boolean {
	if (id.startsWith("gpt-daybreak-")) return true;
	const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(id);
	if (!match || id.startsWith("gpt-realtime")) return false;
	const [major, minor] = [Number(match[1]), Number(match[2] ?? 0)];
	return major > 5 || (major === 5 && minor >= 6);
}

const DEFAULTS = { cacheRetention: "long", instructionCacheRetention: "long" } as const;
const firstBreakpoint = (payload: Payload) =>
	(payload.input as Payload[])
		.flatMap((item) => (Array.isArray(item.content) ? item.content : []))
		.find((part: Payload) => part.prompt_cache_breakpoint)?.prompt_cache_breakpoint;

describe("every catalog model gets its longest supported cache tier by default", () => {
	const openai = getBuiltinModels("openai").filter((model) => model.api === "openai-responses");
	const explicit = openai.filter((model) => isExplicitGeneration(model.id));
	const extended = openai.filter((model) => !isExplicitGeneration(model.id) && OPENAI_EXTENDED_RETENTION.has(model.id));

	it("finds both OpenAI generations in the catalog", () => {
		expect(explicit.length).toBeGreaterThan(0);
		expect(extended.length).toBeGreaterThan(0);
	});

	it.each(explicit.map((model) => [model.id, model] as const))(
		"OpenAI %s: explicit mode with a 12h request TTL and 12h instruction breakpoints",
		async (_id, model) => {
			const payload = await rawPayload(model, "sk-test", [{ role: "user", content: "hi", timestamp: 0 }], DEFAULTS);
			expect(payload.prompt_cache_retention).toBeUndefined();
			expect(payload.prompt_cache_options).toEqual({ ttl: "12h" });
			expect(firstBreakpoint(payload)).toEqual({ mode: "explicit", ttl: "12h" });
			expect(payload.prompt_cache_key).toBe("edge-session");
		},
	);

	it.each(extended.map((model) => [model.id, model] as const))(
		"OpenAI %s: 24h extended retention with the session key",
		async (_id, model) => {
			const payload = await rawPayload(model, "sk-test", [{ role: "user", content: "hi", timestamp: 0 }], DEFAULTS);
			expect(payload.prompt_cache_retention).toBe("24h");
			expect(payload.prompt_cache_options).toBeUndefined();
			expect(payload.prompt_cache_key).toBe("edge-session");
		},
	);

	const azure = getBuiltinModels("azure").filter((model) => model.api === "azure-openai-responses");
	const azureExtended = azure.filter((model) => AZURE_EXTENDED_RETENTION.has(model.id));
	it.each(azureExtended.map((model) => [model.id, { ...model, baseUrl: "http://127.0.0.1:9/openai/v1" }] as const))(
		"Azure %s: 24h extended retention with the session key",
		async (_id, model) => {
			const payload = await rawPayload(model, "test-key", [{ role: "user", content: "hi", timestamp: 0 }], DEFAULTS);
			expect(payload.prompt_cache_retention).toBe("24h");
			expect(payload.prompt_cache_key).toBe("edge-session");
		},
	);

	it.each(azureExtended.map((model) => [model.id, model] as const))(
		"Azure %s: capabilities report the 24h tier the adapter sends",
		(_id, model) => {
			expect(resolveModelCapabilities(model).cache).toEqual({ mechanism: "key", lifetimes: { long: 86_400 } });
		},
	);

	it("sends no retention field to an Azure deployment outside the documented 24h list", async () => {
		const payload = await rawPayload(
			{ ...getBuiltinModel("azure", "gpt-4o"), baseUrl: "http://127.0.0.1:9/openai/v1" },
			"test-key",
			[{ role: "user", content: "hi", timestamp: 0 }],
			DEFAULTS,
		);
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(payload.prompt_cache_options).toBeUndefined();
	});

	it("lets compat.supportsLongCacheRetention opt a deployment-named Azure model in to 24h", async () => {
		const model = { ...azureModel(), id: "prod-gpt-5", compat: { supportsLongCacheRetention: true } };
		const payload = await rawPayload(model, "test-key", [{ role: "user", content: "hi", timestamp: 0 }], DEFAULTS);
		expect(payload.prompt_cache_retention).toBe("24h");
		expect(payload.prompt_cache_key).toBe("edge-session");
		expect(resolveModelCapabilities(model).cache).toEqual({ mechanism: "key", lifetimes: { long: 86_400 } });
		expect(describePayloadLayers(model.api, payload)?.cacheMode).toBe("key+24h");
		const plain = await rawPayload(azureModel(), "test-key", [{ role: "user", content: "hi", timestamp: 0 }], DEFAULTS);
		expect(plain.prompt_cache_retention).toBeUndefined();
	});

	it("reports a declared Azure long lifetime only where the adapter sends 24h", async () => {
		const declared = { ...azureModel(), id: "prod-deployment", promptCache: { long: 86_400 } };
		const payload = await rawPayload(declared, "test-key", [{ role: "user", content: "hi", timestamp: 0 }], DEFAULTS);
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(resolveModelCapabilities(declared).cache.lifetimes.long).toBeUndefined();
		const optedIn = { ...declared, compat: { supportsLongCacheRetention: true } };
		const sent = await rawPayload(optedIn, "test-key", [{ role: "user", content: "hi", timestamp: 0 }], DEFAULTS);
		expect(sent.prompt_cache_retention).toBe("24h");
		expect(resolveModelCapabilities(optedIn).cache.lifetimes.long).toBe(86_400);
	});

	/**
	 * Microsoft: GPT-6 Astra supports prompt cache breakpoints on Standard and PTU-M deployments; earlier models,
	 * GPT-5.6 included, do not on provisioned deployments. A 12h TTL is documented only for "supported Responses API
	 * deployments", so Astra's breakpoints keep the 30m default and the request stays in implicit mode. Microsoft
	 * documents the breakpoint only as `{"mode": "explicit"}`, with the TTL set request-wide through
	 * `prompt_cache_options.ttl` (default 30m), so the Azure breakpoint carries no `ttl` key.
	 */
	const astra = () => ({ ...getBuiltinModel("azure", "gpt-6-astra"), baseUrl: "http://127.0.0.1:9/openai/v1" });
	it("Azure gpt-6-astra: 30m instruction breakpoints in implicit mode", async () => {
		const turn: Message[] = [{ role: "user", content: "hi", timestamp: 0 }];
		const long = await rawPayload(astra(), "test-key", turn, DEFAULTS);
		expect(firstBreakpoint(long)).toStrictEqual({ mode: "explicit" });
		expect(long.prompt_cache_options).toBeUndefined();
		expect(long.prompt_cache_retention).toBeUndefined();
		expect(long.prompt_cache_key).toBe("edge-session");
		expect(describePayloadLayers(astra().api, long)?.cacheMode).toBe("key+breakpoint-30m");
		const short = await rawPayload(astra(), "test-key", turn, {
			cacheRetention: "short",
			instructionCacheRetention: "short",
		});
		expect(firstBreakpoint(short)).toStrictEqual({ mode: "explicit" });
		const split = await rawPayload(astra(), "test-key", turn, {
			...DEFAULTS,
			instructionCacheBoundary: "environment",
		});
		const instructionBlocks = (split.input as Payload[])[0].content as Payload[];
		expect(instructionBlocks.map((block) => block.prompt_cache_breakpoint)).toStrictEqual([
			{ mode: "explicit" },
			{ mode: "explicit" },
		]);
		expect(JSON.stringify(split.input)).not.toContain('"ttl"');
		// A volatile boundary (beside the default `project_context` one) ends the instructions with a block that has no
		// breakpoint; the text is unchanged.
		const tail = await rawPayload(astra(), "test-key", turn, {
			...DEFAULTS,
			instructionVolatileBoundary: "environment",
		});
		const tailBlocks = (tail.input as Payload[])[0].content as Payload[];
		expect(tailBlocks.map((block) => block.prompt_cache_breakpoint)).toStrictEqual([
			{ mode: "explicit" },
			{ mode: "explicit" },
			undefined,
		]);
		expect(tailBlocks.map((block) => block.text).join("")).toBe(instructionBlocks.map((block) => block.text).join(""));
	});

	it("Azure gpt-6-astra: capabilities report the 30m instruction breakpoint tier the adapter sends", () => {
		expect(resolveModelCapabilities(astra()).cache).toEqual({
			mechanism: "explicit-breakpoint",
			lifetimes: { short: 1800 },
		});
	});

	it("OpenAI direct keeps the ttl key on a 30m instruction breakpoint", async () => {
		const model = getBuiltinModel("openai", "gpt-6-astra");
		const turn: Message[] = [{ role: "user", content: "hi", timestamp: 0 }];
		const short = await rawPayload(model, "sk-test", turn, {
			cacheRetention: "short",
			instructionCacheRetention: "short",
		});
		expect(firstBreakpoint(short)).toStrictEqual({ mode: "explicit", ttl: "30m" });
	});

	it("Azure gpt-6-astra: no breakpoint when instructions or history are not cached", async () => {
		const turn: Message[] = [{ role: "user", content: "hi", timestamp: 0 }];
		for (const extra of [
			{ cacheRetention: "long", instructionCacheRetention: "none" },
			{ cacheRetention: "none", instructionCacheRetention: "long" },
		]) {
			const payload = await rawPayload(astra(), "test-key", turn, extra);
			expect(firstBreakpoint(payload), JSON.stringify(extra)).toBeUndefined();
			expect(payload.prompt_cache_options).toBeUndefined();
		}
	});

	const azureExplicitGeneration = azure.filter((model) => isExplicitGeneration(model.id));
	it("finds Azure GPT-5.6+ models besides Astra", () => {
		expect(azureExplicitGeneration.map((model) => model.id)).toEqual(
			expect.arrayContaining(["gpt-6-astra", "gpt-5.6-sol", "gpt-6.1-sol"]),
		);
	});

	it.each(
		azureExplicitGeneration.map((model) => [model.id, { ...model, baseUrl: "http://127.0.0.1:9/openai/v1" }] as const),
	)("Azure %s: no prompt_cache_retention and no prompt_cache_options", async (id, model) => {
		const payload = await rawPayload(model, "test-key", [{ role: "user", content: "hi", timestamp: 0 }], DEFAULTS);
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(payload.prompt_cache_options).toBeUndefined();
		if (id !== "gpt-6-astra") expect(firstBreakpoint(payload)).toBeUndefined();
	});

	/**
	 * Standard pay-as-you-go deployments of GPT-5.6 and later accept breakpoints and a 12h request TTL; provisioned
	 * GPT-5.6 deployments do not support breakpoints, and the adapter cannot tell them apart, so explicit mode is a
	 * per-deployment opt-in: `compat.supportsExplicitPromptCacheMode: true`. The TTL stays request-wide and the
	 * breakpoints carry no `ttl` key, as Microsoft documents them.
	 */
	const optedIn = (model: Model<"azure-openai-responses" | "openai-completions">): Model<"azure-openai-responses"> => {
		const azureResponses = model as Model<"azure-openai-responses">;
		return {
			...azureResponses,
			baseUrl: "http://127.0.0.1:9/openai/v1",
			compat: { ...azureResponses.compat, supportsExplicitPromptCacheMode: true },
		};
	};
	it.each(azureExplicitGeneration.map((model) => [model.id, optedIn(model)] as const))(
		"Azure %s with compat.supportsExplicitPromptCacheMode: 12h request TTL and instruction breakpoints",
		async (_id, model) => {
			const payload = await rawPayload(model, "test-key", [{ role: "user", content: "hi", timestamp: 0 }], DEFAULTS);
			expect(payload.prompt_cache_options).toStrictEqual({ ttl: "12h" });
			expect(payload.prompt_cache_retention).toBeUndefined();
			expect(payload.prompt_cache_key).toBe("edge-session");
			expect(firstBreakpoint(payload)).toStrictEqual({ mode: "explicit" });
			expect(JSON.stringify(payload.input)).not.toContain('"ttl"');
			expect(describePayloadLayers(model.api, payload)?.cacheMode).toBe("key+12h+breakpoint-12h");
			expect(resolveModelCapabilities(model).cache).toEqual({
				mechanism: "explicit-breakpoint",
				lifetimes: { short: 1800, long: 43_200 },
			});
		},
	);

	it("Azure explicit opt-in: short retention keeps 30m, none selects explicit mode with no breakpoints", async () => {
		const model = optedIn(azureModel());
		const turn: Message[] = [{ role: "user", content: "hi", timestamp: 0 }];
		const short = await rawPayload(model, "test-key", turn, {
			cacheRetention: "short",
			instructionCacheRetention: "short",
		});
		expect(short.prompt_cache_options).toBeUndefined();
		expect(firstBreakpoint(short)).toStrictEqual({ mode: "explicit" });
		const none = await rawPayload(model, "test-key", turn, {
			cacheRetention: "none",
			instructionCacheRetention: "long",
		});
		expect(none.prompt_cache_options).toStrictEqual({ mode: "explicit" });
		expect(none.prompt_cache_key).toBeUndefined();
		expect(firstBreakpoint(none)).toBeUndefined();
	});

	// Azure breakpoints carry no ttl of their own and inherit the request TTL, so the request TTL is the longer of the
	// instruction and history tiers: long instructions behind short history keep their 12h.
	it.each([
		{ instructions: "long", history: "short" },
		{ instructions: "short", history: "long" },
	] as const)(
		"Azure explicit opt-in: $instructions instructions with $history history send a 12h request TTL",
		async ({ instructions, history }) => {
			const payload = await rawPayload(
				optedIn(azureModel()),
				"test-key",
				[{ role: "user", content: "hi", timestamp: 0 }],
				{
					cacheRetention: history,
					instructionCacheRetention: instructions,
				},
			);
			expect(payload.prompt_cache_options).toStrictEqual({ ttl: "12h" });
			expect(firstBreakpoint(payload)).toStrictEqual({ mode: "explicit" });
			expect(JSON.stringify(payload.input)).not.toContain('"ttl"');
		},
	);

	it("Azure explicit opt-in: no instruction breakpoints and a 30m request for none instructions and short history", async () => {
		const payload = await rawPayload(
			optedIn(azureModel()),
			"test-key",
			[{ role: "user", content: "hi", timestamp: 0 }],
			{
				cacheRetention: "short",
				instructionCacheRetention: "none",
			},
		);
		expect(payload.prompt_cache_options).toBeUndefined();
		expect(firstBreakpoint(payload)).toBeUndefined();
	});

	it("Azure explicit opt-in with compat.supportsLongCacheRetention: false stays at 30m", async () => {
		const model = {
			...optedIn(azureModel()),
			compat: { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: false },
		};
		const payload = await rawPayload(model, "test-key", [{ role: "user", content: "hi", timestamp: 0 }], DEFAULTS);
		expect(payload.prompt_cache_options).toBeUndefined();
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(firstBreakpoint(payload)).toStrictEqual({ mode: "explicit" });
		expect(resolveModelCapabilities(model).cache).toEqual({
			mechanism: "explicit-breakpoint",
			lifetimes: { short: 1800 },
		});
	});

	/** Routes whose provider manages retention: nothing configurable to send beyond a routing key. */
	it.each([
		["openai-codex", () => getBuiltinModel("openai-codex", "gpt-5.5"), codexToken],
		["xai", () => getBuiltinModel("xai", "grok-4.3"), "xai-test"],
		["mistral", () => getBuiltinModel("mistral", "codestral-latest"), "test-key"],
		["deepseek", () => getBuiltinModel("deepseek", "deepseek-v4-pro"), "test-key"],
		["groq", () => getBuiltinModel("groq", "openai/gpt-oss-120b"), "test-key"],
		["cerebras", () => getBuiltinModel("cerebras", "gpt-oss-120b"), "test-key"],
		["google", () => getBuiltinModel("google", "gemini-2.5-pro"), "test-key"],
	] as const)("%s: sends no OpenAI retention field it does not accept", async (_name, make, key) => {
		const payload = await rawPayload(make(), key, [{ role: "user", content: "hi", timestamp: 0 }], DEFAULTS);
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(payload.prompt_cache_options).toBeUndefined();
	});
});

describe("payload describer coverage", () => {
	const CACHE_FIELD =
		/"(prompt_cache_key|promptCacheKey|prompt_cache_retention|prompt_cache_options|prompt_cache_breakpoint|cache_control|cachePoint|cachedContent)"/;
	/** Routes that send no cache field on any model (implicit caching, or a host that takes none); a new one must be listed. */
	const NO_CACHE_FIELD = new Set([
		"google-generative-ai:google",
		"google-generative-ai:opencode",
		"google-generative-ai:opencode-go",
		"google-vertex:google-vertex",
		"openai-completions:ant-ling",
		"openai-completions:azure",
		"openai-completions:baseten",
		"openai-completions:cloudflare-ai-gateway",
		"openai-completions:cloudflare-workers-ai",
		"openai-completions:fireworks",
		"openai-completions:nvidia",
		"openai-completions:together",
	]);
	const groups = new Map<string, Model<any>[]>();
	for (const provider of getBuiltinProviders()) {
		for (const model of getBuiltinModels(provider) as Model<any>[]) {
			const key = `${model.api}:${model.provider}`;
			groups.set(key, [...(groups.get(key) ?? []), model]);
		}
	}

	async function defaultPayload(model: Model<any>): Promise<Payload> {
		const local = model.baseUrl ? model : { ...model, baseUrl: "http://127.0.0.1:9/v1" };
		const key = model.api === "openai-codex-responses" ? codexToken : "sk-test";
		return rawPayload(local, key, [{ role: "user", content: "hi", timestamp: 0 }], DEFAULTS);
	}

	it.each([...groups].map(([key, models]) => [key, models] as const))(
		"describes %s on a model whose default payload carries a cache field",
		async (key, models) => {
			for (const model of models) {
				const payload = await defaultPayload(model);
				if (!CACHE_FIELD.test(JSON.stringify(payload))) continue;
				expect(NO_CACHE_FIELD.has(key), `${key} sends cache fields (${model.id})`).toBe(false);
				expect(describePayloadLayers(model.api, payload), `${key} sends cache fields (${model.id})`).toBeDefined();
				return;
			}
			expect(NO_CACHE_FIELD.has(key), `no ${key} model sends a cache field`).toBe(true);
		},
	);
});
