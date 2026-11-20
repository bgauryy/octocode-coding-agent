import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { stream as bedrockStream } from "../src/api/bedrock-converse-stream.ts";
import { stream as completionsStream } from "../src/api/openai-completions.ts";
import { resolveModelCapabilities } from "../src/models/capabilities.ts";
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "../src/providers/all.ts";
import type { Api, AssistantMessage, Message, Model, StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import {
	assistant,
	type Block,
	capture,
	grepTool,
	lastMarkedMessage,
	markers,
	type Payload,
	PNG,
	systemUpdate,
	toolCall,
	toolResult,
	transcript,
	user,
	withoutMarkers,
} from "./anthropic-cache-fixtures.ts";

/**
 * Cache edge cases for the Anthropic-format adapters that the per-adapter suites leave open: the Bedrock one-hour TTL
 * on models that only accept five minutes, cross-request breakpoint positions in a session that combines every marker
 * source at once (a split prompt, native tool changes, effort markers, a parallel turn far past the
 * 20-block lookback), and caching turned off in that same combination.
 */

// ---------------------------------------------------------------------------------------------------------------
// Bedrock: one-hour cache points only where the model accepts them
// ---------------------------------------------------------------------------------------------------------------

class Captured extends Error {}
type CachePoint = { type: string; ttl?: string };
type BedrockBlock = { cachePoint?: CachePoint; [key: string]: unknown };
interface BedrockPayload {
	system?: BedrockBlock[];
	toolConfig?: { tools: BedrockBlock[] };
	messages: { role: string; content: BedrockBlock[] }[];
}

async function bedrockPoints(
	model: Model<"bedrock-converse-stream">,
	options: StreamOptions = { cacheRetention: "long" },
): Promise<CachePoint[]> {
	const payload = await bedrockPayload(model, options);
	return [
		...(payload.toolConfig?.tools ?? []),
		...(payload.system ?? []),
		...payload.messages.flatMap((message) => message.content),
	].flatMap((block) => (block.cachePoint ? [block.cachePoint] : []));
}

async function bedrockPayload(
	model: Model<"bedrock-converse-stream">,
	options: StreamOptions = { cacheRetention: "long" },
): Promise<BedrockPayload> {
	let payload: BedrockPayload | undefined;
	const context = normalizeContext({
		systemPrompt: "Stable instructions",
		messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
	});
	await bedrockStream(model, context, {
		env: {},
		...options,
		onPayload: (value) => {
			payload = structuredClone(value) as BedrockPayload;
			throw new Captured();
		},
	}).result();
	if (!payload) throw new Error("payload not captured");
	return payload;
}

describe("Bedrock one-hour cache points per model", () => {
	// AWS "Supported models, Regions, and explicit caching limits" (fetched 2026-11-08) lists "5 minutes, 1 hour" for
	// Claude 5.x, Opus 4.5-4.8, Sonnet 4.6 and Haiku 4.5, and warns that a `ttl` on a five-minute-only model "can result
	// in a ValidationException". Claude Sonnet 4 and Opus 4.1 are not in the one-hour list.
	it.each([
		"us.anthropic.claude-opus-5-5",
		"global.anthropic.claude-sonnet-5",
		"us.anthropic.claude-opus-4-8",
		"anthropic.claude-opus-4-5-20251101-v1:0",
		"global.anthropic.claude-sonnet-4-6",
		"us.anthropic.claude-haiku-4-5-20251001-v1:0",
		"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
	] as const)("keeps one-hour points on %s, which supports them", async (id) => {
		const points = await bedrockPoints(getBuiltinModel("amazon-bedrock", id));
		expect(points.length).toBeGreaterThan(0);
		for (const point of points) expect(point.ttl).toBe("1h");
	});

	it.each(["us.anthropic.claude-opus-4-1-20250805-v1:0", "anthropic.claude-opus-4-1-20250805-v1:0"] as const)(
		"sends five-minute points on %s instead of a ttl it rejects",
		async (id) => {
			const points = await bedrockPoints(getBuiltinModel("amazon-bedrock", id));
			expect(points.length).toBeGreaterThan(0);
			for (const point of points) expect(point.ttl).toBeUndefined();
		},
	);

	it("lets an explicit supportsLongCacheRetention override the model rule", async () => {
		const base = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-1-20250805-v1:0");
		const points = await bedrockPoints({ ...base, compat: { ...base.compat, supportsLongCacheRetention: true } });
		for (const point of points) expect(point.ttl).toBe("1h");
	});

	// Profile names in every spelling of Sonnet 4 and Opus 4: display names, Anthropic aliases ("-4-0"), and
	// vendor-prefixed or Vertex-style ids with "/" and "@" separators.
	it.each([
		"Claude Sonnet 4",
		"claude-sonnet-4-0",
		"claude-opus-4-0",
		"Claude Sonnet 4.0",
		"Claude Opus 4.0",
		"anthropic/claude-sonnet-4@20250514",
		"anthropic/claude-opus-4-1@20250805",
		"claude-opus-4@20250514",
	])("sends five-minute points for an application inference profile named %s", async (name) => {
		const base = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-1-20250805-v1:0");
		const profile = {
			...base,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123",
			name,
		};
		const points = await bedrockPoints(profile);
		expect(points.length).toBeGreaterThan(0);
		for (const point of points) expect(point.ttl).toBeUndefined();
	});

	// Layered retention on a five-minute-only model: no layer may carry a ttl, whichever layer asks for long.
	it.each([
		{ model: "us.anthropic.claude-opus-4-1-20250805-v1:0", history: "short", instructions: "long" },
		{ model: "us.anthropic.claude-opus-4-1-20250805-v1:0", history: "long", instructions: "short" },
	] as const)(
		"sends only ttl-less points on $model with $instructions instructions and $history history",
		async ({ model, history, instructions }) => {
			const points = await bedrockPoints(getBuiltinModel("amazon-bedrock", model), {
				cacheRetention: history,
				instructionCacheRetention: instructions,
			});
			expect(points.length).toBeGreaterThan(0);
			for (const point of points) expect(point).toEqual({ type: "default" });
		},
	);

	// A models.json profile name is free text: "claude-sonnet-4.5" is Sonnet 4.5, which accepts one hour.
	it.each([
		"claude-sonnet-4.5",
		"Claude-Opus-4.6",
		"claude_sonnet_4.6",
		"anthropic/claude-sonnet-4-5@20250929",
		"claude-opus-4-5@20251101",
	])("keeps one-hour points for an application inference profile named %s", async (name) => {
		const base = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const profile = {
			...base,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123",
			name,
		};
		const points = await bedrockPoints(profile);
		expect(points.length).toBeGreaterThan(0);
		for (const point of points) expect(point.ttl).toBe("1h");
	});

	/**
	 * AWS "Supported models, Regions, and explicit caching limits"
	 * (https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html, fetched 2026-11-08) lists Nova 2 Lite,
	 * Nova Pro, Nova Lite and Nova Micro with explicit cache checkpoints on `system` and `messages` only, a 5-minute TTL
	 * only (a `ttl` field "can result in a ValidationException") and at most four checkpoints. Nova Premier is not
	 * listed and keeps implicit caching.
	 */
	it.each([
		"us.amazon.nova-pro-v1:0",
		"amazon.nova-lite-v1:0",
		"eu.amazon.nova-micro-v1:0",
		"global.amazon.nova-2-lite-v1:0",
	] as const)("%s: ttl-less cache points on system and messages, none on tools", async (id) => {
		const model = getBuiltinModel("amazon-bedrock", id);
		for (const retention of ["long", "short"] as const) {
			const payload = await bedrockPayload(model, {
				cacheRetention: retention,
				instructionCacheRetention: retention,
			});
			expect(payload.toolConfig?.tools.some((block) => block.cachePoint)).toBe(false);
			expect(payload.system?.filter((block) => block.cachePoint).map((block) => block.cachePoint)).toEqual([
				{ type: "default" },
			]);
			expect(payload.messages.at(-1)?.content.at(-1)?.cachePoint).toEqual({ type: "default" });
		}
		expect(resolveModelCapabilities(model, {}).cache).toEqual({ mechanism: "markers", lifetimes: { short: 300 } });
		expect(await bedrockPoints(model, { cacheRetention: "none", instructionCacheRetention: "none" })).toEqual([]);
	});

	it("keeps Nova Premier, which AWS does not list for explicit caching, on implicit caching", async () => {
		const model = getBuiltinModel("amazon-bedrock", "us.amazon.nova-premier-v1:0");
		expect(await bedrockPoints(model)).toEqual([]);
		expect(resolveModelCapabilities(model, {}).cache.mechanism).toBe("implicit");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Anthropic: every marker source in one session
// ---------------------------------------------------------------------------------------------------------------

const opus = getBuiltinModel("anthropic", "claude-opus-5-5");
const API_KEY = "sk-ant-api03-test";
const signed = (text: string, signature: string) => ({
	type: "thinking" as const,
	thinking: text,
	thinkingSignature: signature,
});

/** 25 parallel calls: 25 tool_use and 25 tool_result blocks plus an error result whose images follow the results. */
const PARALLEL = Array.from({ length: 25 }, (_, index) => `p${index}`);

type Turn = (model: Model<"anthropic-messages">) => Message[];
const turns: Turn[] = [
	() => [user("task")],
	(model) => [assistant(model, [signed("plan", "sig-1"), toolCall("c1")]), toolResult("c1")],
	(model) => [
		assistant(model, [toolCall("c2")]),
		toolResult("c2"),
		// Interleaved: a tool addition and a section update land between two tool turns.
		systemUpdate("Prefer grep for searches.", [grepTool]),
		systemUpdate("Section changed."),
	],
	(model) => [
		assistant(model, [
			signed("fan out", "sig-2"),
			{ type: "text", text: "reading all" },
			...PARALLEL.map((id) => toolCall(id)),
		]),
		...PARALLEL.map((id, index) =>
			index === 3
				? {
						...toolResult(id),
						isError: true,
						content: [
							{ type: "text" as const, text: "failed" },
							{ type: "image" as const, data: PNG, mimeType: "image/png" },
						],
					}
				: toolResult(id),
		),
	],
	(model) => [
		assistant(model, [toolCall("g1", "grep")]),
		toolResult("g1", "grep"),
		user([
			{ type: "text", text: "see this" },
			{ type: "image", data: PNG, mimeType: "image/png" },
		]),
	],
	(model) => [assistant(model, [{ type: "text", text: "noted" }]), systemUpdate("Late section."), user("continue")],
];

async function session(options: StreamOptions & { apiKey?: string }): Promise<Payload[]> {
	const payloads: Payload[] = [];
	const messages: Message[] = [];
	for (const turn of turns) {
		messages.push(...turn(opus));
		payloads.push(
			await capture(opus, transcript([...messages]), { instructionCacheBoundary: "project_context", ...options }),
		);
	}
	return payloads;
}

function canonical(payload: Payload, messages = payload.messages): string {
	const blocks = messages.map((message) =>
		typeof message.content === "string" ? { ...message, content: [{ type: "text", text: message.content }] } : message,
	);
	return JSON.stringify(withoutMarkers([payload.tools, payload.system, blocks]));
}

const rank = (ttl: string | undefined) => (ttl === "1h" ? 2 : 1);

describe("Anthropic session with every marker source", () => {
	it.each([
		{ name: "long", options: { cacheRetention: "long" as const } },
		{
			name: "long instructions, short history",
			options: { cacheRetention: "short" as const, instructionCacheRetention: "long" as const },
		},
		{ name: "short", options: { cacheRetention: "short" as const } },
	])("split prompt, native tool changes, effort markers ($name)", async ({ options }) => {
		const payloads = await session({ apiKey: API_KEY, ...options });
		for (const [index, payload] of payloads.entries()) {
			const found = markers(payload);
			expect(found.length).toBeLessThanOrEqual(4);
			// A longer TTL never follows a shorter one in prefix order.
			const ranks = found.map(({ block }) => rank(block.cache_control?.ttl));
			for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeLessThanOrEqual(ranks[i - 1]);
			// The base and project blocks carry the instruction markers.
			expect(payload.system?.map((block) => block.cache_control !== undefined)).toEqual([true, true]);
			// Tools keep their own names; the list never changes after the first request.
			expect(payload.tools?.map((tool) => tool.name)).toEqual(["read", "__pi_deferred_placeholder__"]);
			if (index === 0) continue;

			const previous = payloads[index - 1];
			const tail = lastMarkedMessage(previous);
			// Every later request has a previous tail, so the lookback marker is always placed.
			expect(found.filter(({ section }) => section === "messages")).toHaveLength(2);
			// The bytes the previous request cached are an exact prefix of this one...
			expect(canonical(payload, payload.messages.slice(0, tail + 1))).toBe(
				canonical(previous, previous.messages.slice(0, tail + 1)),
			);
			// ...and its write position carries a marker again, however many blocks the new turn added.
			const before = previous.messages[tail].content as Block[];
			const after = payload.messages[tail].content as Block[];
			expect(after.at(-1)?.cache_control).toEqual(before.at(-1)?.cache_control);
			expect(after.at(-1)?.cache_control).toBeDefined();
		}
	});

	it("sends no cache_control anywhere when caching is off, whatever the instruction preference", async () => {
		const payloads = await session({ apiKey: API_KEY, cacheRetention: "none", instructionCacheRetention: "long" });
		for (const payload of payloads) expect(JSON.stringify(payload)).not.toContain("cache_control");
	});

	// Known miss, pinned with `it.fails` so it runs and flags the change: the held update moves behind the retry, so the
	// tool turn before it is read again (one turn per abort). Flushing held updates before a user message that follows a
	// tool result keeps the prefix, but puts a system message before a user message (not yet verified against the live
	// API) and changes model-visible order. When a fix lands, this fails: turn it into `it`.
	it.fails("keeps the previous tail cached when an aborted reply is followed by a user message after a system update", async () => {
		// Request N ends with tool results and a tool addition; the reply is aborted empty and the user writes again.
		const base: Message[] = [
			user("task"),
			assistant(opus, [toolCall("c1")]),
			toolResult("c1"),
			systemUpdate("Prefer grep for searches.", [grepTool]),
		];
		const empty: AssistantMessage = { ...assistant(opus, []), stopReason: "aborted" };
		const before = await capture(opus, transcript(base), { apiKey: API_KEY });
		const after = await capture(opus, transcript([...base, empty, user("retry")]), { apiKey: API_KEY });
		const tail = lastMarkedMessage(before);
		expect(canonical(after, after.messages.slice(0, tail + 1))).toBe(
			canonical(before, before.messages.slice(0, tail + 1)),
		);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Provider tier matrix: every catalog Claude route sends its default TTL under the default (long) setting
// ---------------------------------------------------------------------------------------------------------------

/** Every `cache_control` / `cachePoint` object in a captured payload, outside caller-defined schemas and arguments. */
function cacheMarkers(payload: unknown): CachePoint[] {
	const found: CachePoint[] = [];
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) return value.forEach(walk);
		if (typeof value !== "object" || value === null) return;
		for (const [key, child] of Object.entries(value)) {
			if (key === "cache_control" || key === "cachePoint") found.push(child as CachePoint);
			else if (!["input_schema", "inputSchema", "parameters", "input", "arguments"].includes(key)) walk(child);
		}
	};
	walk(payload);
	return found;
}

const isClaude = (model: Model<Api>) => /claude/i.test(`${model.id} ${model.name ?? ""}`);
const claudeRoutes = getBuiltinProviders().flatMap((provider) =>
	(getBuiltinModels(provider) as Model<Api>[])
		.filter(isClaude)
		.map((model) => ({ route: `${provider}/${model.id} (${model.api})`, model })),
);

/**
 * Catalog Bedrock IDs whose models accept only five-minute cache points, copied from the "Supported TTL" column of the
 * AWS model cards (fetched 2026-11-08), independent of the adapter's model rule:
 * - https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4.html: "5 minutes"
 * - https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-1.html: "5 minutes"
 * - https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-5.html: "5 minutes, 1 hour"
 *   (Sonnet 4.5 is missing from the prompt-caching table but its card lists one hour)
 * - https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html: "5 minutes, 1 hour" for Claude 5.x,
 *   Opus 4.5-4.8, Sonnet 4.6 and Haiku 4.5
 * Every other catalog Bedrock Claude model accepts one hour. Sonnet 4 reached end of life on 2026-10-14 and is not in
 * the catalog.
 */
const FIVE_MINUTE_ONLY_BEDROCK_IDS = [
	"anthropic.claude-opus-4-1-20250805-v1:0",
	"us.anthropic.claude-opus-4-1-20250805-v1:0",
];

/**
 * Anthropic Messages hosts whose documentation verifies the one-hour TTL: Anthropic's own API, OpenCode, and OpenRouter
 * for its Claude models. Other Anthropic-protocol gateways (Vercel, Cloudflare, Copilot, MiniMax) default to five minutes.
 */
const ONE_HOUR_ANTHROPIC_HOSTS = ["api.anthropic.com", "opencode.ai", "openrouter.ai"];

/**
 * The TTL the route sends by default: one hour, except Bedrock models that accept only five minutes and Anthropic
 * Messages gateways whose one-hour tier is not documented.
 */
function defaultTtl(model: Model<Api>): string | undefined {
	if (model.api === "bedrock-converse-stream")
		return FIVE_MINUTE_ONLY_BEDROCK_IDS.includes(model.id) ? undefined : "1h";
	if (model.api === "anthropic-messages")
		return ONE_HOUR_ANTHROPIC_HOSTS.includes(new URL(model.baseUrl).hostname) ? "1h" : undefined;
	return "1h";
}

const bedrockClaudeModels = claudeRoutes
	.map(({ model }) => model)
	.filter((model): model is Model<"bedrock-converse-stream"> => model.api === "bedrock-converse-stream");

const history = (model: Model<Api>): Message[] => [
	user("one"),
	{ ...assistant(model as Model<"anthropic-messages">, [toolCall("c1")]), stopReason: "toolUse" },
	toolResult("c1"),
	{ ...assistant(model as Model<"anthropic-messages">, [{ type: "text", text: "done" }]), stopReason: "stop" },
	user("two"),
];

async function captureRoute(model: Model<Api>, options: StreamOptions): Promise<unknown> {
	const context = normalizeContext({
		systemPrompt: "Stable agent instructions",
		messages: history(model),
		tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
	});
	let payload: unknown;
	const onPayload = (value: unknown) => {
		payload = structuredClone(value);
		throw new Captured();
	};
	const common = { apiKey: "test-key", env: {}, ...options, onPayload };
	if (model.api === "anthropic-messages") {
		await anthropicStream(model as Model<"anthropic-messages">, context, common).result();
	} else if (model.api === "bedrock-converse-stream") {
		await bedrockStream(model as Model<"bedrock-converse-stream">, context, common).result();
	} else if (model.api === "openai-completions") {
		await completionsStream(model as Model<"openai-completions">, context, common).result();
	} else {
		throw new Error(`no capture for ${model.api}`);
	}
	if (payload === undefined) throw new Error("payload not captured");
	return payload;
}

describe("Claude provider tier matrix", () => {
	it("finds Claude routes for every Anthropic-format family in the catalog", () => {
		const apis = new Set(claudeRoutes.map(({ model }) => model.api));
		expect([...apis].sort()).toEqual(["anthropic-messages", "bedrock-converse-stream", "openai-completions"]);
	});

	// The default settings ask for long instructions and long history, so both layers carry the route's default tier:
	// one hour where it is documented (Anthropic, OpenCode, Bedrock models that list it, OpenAI-format routes), five
	// minutes on the other Anthropic-protocol gateways.
	it.each(claudeRoutes)("$route sends its default TTL on instructions and history by default", async ({ model }) => {
		const found = cacheMarkers(await captureRoute(model, { cacheRetention: "long" }));
		// Instructions (tools/system), the final message and the previous tail.
		expect(found.length).toBeGreaterThanOrEqual(3);
		expect(found.length).toBeLessThanOrEqual(4);
		const ttl = defaultTtl(model);
		for (const marker of found) expect(marker.ttl).toBe(ttl);
	});

	it.each(claudeRoutes)(
		"$route falls back to five-minute markers when long retention is ruled out",
		async ({ model }) => {
			const limited = { ...model, compat: { ...model.compat, supportsLongCacheRetention: false } } as Model<Api>;
			const found = cacheMarkers(await captureRoute(limited, { cacheRetention: "long" }));
			expect(found.length).toBeGreaterThanOrEqual(3);
			for (const marker of found) expect(marker.ttl).toBeUndefined();
		},
	);
});

describe("Bedrock five-minute-only models", () => {
	it("are exactly the catalog IDs the AWS model cards list without the one-hour TTL", async () => {
		const fiveMinute: string[] = [];
		for (const model of bedrockClaudeModels) {
			const points = await bedrockPoints(model);
			expect(points.length).toBeGreaterThan(0);
			if (points.every((point) => point.ttl === undefined)) fiveMinute.push(model.id);
		}
		expect(fiveMinute.sort()).toEqual([...FIVE_MINUTE_ONLY_BEDROCK_IDS].sort());
	});

	// The /status Cache line reads the long lifetime from the capabilities, so they must report what the wire sends.
	it.each(bedrockClaudeModels.map((model) => ({ id: model.id, model })))(
		"$id reports the long lifetime only when its cache points carry one hour",
		async ({ model }) => {
			for (const override of [undefined, true, false]) {
				const variant =
					override === undefined
						? model
						: { ...model, compat: { ...model.compat, supportsLongCacheRetention: override } };
				const points = await bedrockPoints(variant);
				const ttls = new Set(points.map((point) => point.ttl));
				expect(ttls.size).toBe(1);
				const long = resolveModelCapabilities(variant, {}).cache.lifetimes.long;
				expect(long).toBe(ttls.has("1h") ? 3600 : undefined);
			}
		},
	);
});
