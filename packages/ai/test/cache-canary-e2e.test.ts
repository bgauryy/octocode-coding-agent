/**
 * Opt-in live cache canary (S0.2 of the tool-search cache RFC). Per provider family: two turns, a tool addition, two
 * more turns, recording `cacheRead` and `cacheWrite` per request and asserting that each request reads the previous
 * prefix from the provider's cache.
 *
 * Runs only with `OCTOCODE_LIVE_CACHE_CANARY=1` and the family's API key; it spends real tokens. Narrow it with
 * `OCTOCODE_LIVE_CACHE_CANARY_PROVIDERS=anthropic,openai` and pick models with
 * `OCTOCODE_LIVE_CACHE_CANARY_<PROVIDER>_MODEL=<id>[,<id>...]` (default: the provider's cheapest text model), for
 * example one model per transport of a gateway such as OpenCode.
 */
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { completeSimple } from "../src/compat.ts";
import { getEnvApiKey } from "../src/env-api-keys.ts";
import { type BuiltinProvider, getBuiltinModels } from "../src/providers/all.ts";
import type { Api, AssistantMessage, Context, Message, Model, SimpleStreamOptions, Tool, Usage } from "../src/types.ts";
import { getToolLoadingMode } from "../src/utils/tool-loading.ts";

const FAMILIES: BuiltinProvider[] = [
	"anthropic",
	"openai",
	"google",
	"xai",
	"mistral",
	"openrouter",
	"opencode",
	"opencode-go",
];
const ENABLED = process.env.OCTOCODE_LIVE_CACHE_CANARY === "1";
const SELECTED = process.env.OCTOCODE_LIVE_CACHE_CANARY_PROVIDERS?.split(",").map((name) => name.trim());
/** Share of the previous request's prompt that a following request must read from cache. */
const MIN_READ_SHARE = 0.8;
/** Providers cache asynchronously; give the previous request time to land. */
const SETTLE_MS = 4000;

/** The models to probe: the listed overrides that exist, or the cheapest text model. */
function pickModels(provider: BuiltinProvider): Model<Api>[] {
	const models = (getBuiltinModels(provider) as Model<Api>[]).filter((model) => model.input.includes("text"));
	const override = process.env[`OCTOCODE_LIVE_CACHE_CANARY_${provider.toUpperCase().replace(/-/g, "_")}_MODEL`];
	if (override) {
		return override.split(",").flatMap((id) => models.filter((model) => model.id === id.trim()));
	}
	const cheapest = [...models].sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output))[0];
	return cheapest ? [cheapest] : [];
}

const promptTokens = (usage: Usage) => usage.input + usage.cacheRead + usage.cacheWrite;

function probeTool(name: string): Tool {
	return {
		name,
		description: `Probe tool ${name}. Never call it; it exists to exercise tool loading.`,
		parameters: Type.Object({ value: Type.String() }),
	};
}

/**
 * Gemini caches implicitly and provider-side, only above a minimum prefix that is not fixed by the API. Live probes of
 * `opencode/gemini-3.5-flash-lite` over `google-generative-ai` hit the cache from about 4.1k prompt tokens (4,003 never
 * hit; 4,067 hit; 4,259 missed once) and never at 3.8k, so Gemini models get a prefix of about 12k tokens. Docs:
 * https://ai.google.dev/gemini-api/docs/caching.
 */
const GEMINI_RULES = 400;
const DEFAULT_RULES = 120;

/** Stable text far above every provider's minimum cacheable prefix; the nonce keeps runs from sharing entries. */
function longInstructions(rules: number): string {
	const nonce = `${Date.now()}-${Math.random()}`;
	const filler = Array.from(
		{ length: rules },
		(_, index) =>
			`Rule ${index}: keep this text byte-stable across requests so the provider can reuse the cached prefix and report cache read and cache write usage.`,
	);
	return `You are a terse assistant. Cache nonce: ${nonce}\n\n${filler.join("\n")}`;
}

const INSTRUCTIONS = longInstructions(DEFAULT_RULES);
const GEMINI_INSTRUCTIONS = longInstructions(GEMINI_RULES);
const isGemini = (model: Model<Api>) => model.api === "google-generative-ai" || model.api === "google-vertex";

const user = (content: string): Message => ({ role: "user", content, timestamp: Date.now() });

interface Turn {
	label: string;
	usage: Usage;
}

async function runCanary(provider: BuiltinProvider, model: Model<Api>, apiKey: string | undefined) {
	const sessionId = `cache-canary-${Date.now()}`;
	const options: SimpleStreamOptions = {
		apiKey,
		maxTokens: 512,
		sessionId,
		cacheRetention: "short",
		instructionCacheRetention: "long",
	};
	const messages: Message[] = [];
	const turns: Turn[] = [];
	const send = async (label: string, content: string) => {
		messages.push(user(content));
		const context: Context = {
			systemPrompt: isGemini(model) ? GEMINI_INSTRUCTIONS : INSTRUCTIONS,
			tools: [probeTool("probe_a")],
			messages,
		};
		const reply: AssistantMessage = await completeSimple(model, context, options);
		expect(reply.stopReason, `${provider} ${label}: ${reply.errorMessage ?? ""}`).not.toBe("error");
		messages.push(reply);
		turns.push({ label, usage: reply.usage });
		await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
	};
	await send("turn 1", "Reply with the single word OK.");
	await send("turn 2", "Reply with the single word OK again.");
	// A tool_search load: a mid-conversation system message that adds one tool.
	messages.push({ role: "system", content: "", toolsAdded: [probeTool("probe_b")], timestamp: Date.now() });
	await send("turn 3 (after tool load)", "Reply with the single word OK a third time.");
	await send("turn 4", "Reply with the single word OK a fourth time.");
	return turns;
}

describe.skipIf(!ENABLED)("live prompt-cache canary", () => {
	for (const provider of FAMILIES) {
		const apiKey = getEnvApiKey(provider);
		const skip = !apiKey || (SELECTED !== undefined && !SELECTED.includes(provider));
		const models = skip ? [] : pickModels(provider);
		if (models.length === 0) {
			it.skip(`${provider}: each request reads the previous prefix`, () => {});
			continue;
		}
		for (const model of models) {
			defineCanary(provider, model, apiKey);
		}
	}
});

function defineCanary(provider: BuiltinProvider, model: Model<Api>, apiKey: string | undefined): void {
	it(`${provider}/${model.id}: each request reads the previous prefix`, { retry: 1, timeout: 240_000 }, async () => {
		const turns = await runCanary(provider, model, apiKey);
		const nativeLoading = getToolLoadingMode(model) !== "none";
		// The record is the canary's output: one line per request.
		console.log(
			`cache canary ${provider}/${model.id} (tool loading: ${getToolLoadingMode(model)})\n${turns
				.map(
					({ label, usage }) =>
						`  ${label}: prompt=${promptTokens(usage)} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}`,
				)
				.join("\n")}`,
		);
		const covered = (index: number) =>
			turns[index].usage.cacheRead >= promptTokens(turns[index - 1].usage) * MIN_READ_SHARE;
		expect(covered(1), "turn 2 reads the turn 1 prefix").toBe(true);
		// Without native tool loading the load rewrites the tool list, so that one request may miss; with it, the prefix holds.
		if (nativeLoading) expect(covered(2), "turn 3 keeps the prefix across a tool load").toBe(true);
		expect(covered(3), "turn 4 reads the turn 3 prefix").toBe(true);
	});
}
