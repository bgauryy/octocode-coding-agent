import {
	type Api,
	type Model,
	type ProviderEnv,
	resolveModelCapabilities,
	type StreamOptions,
} from "@octocodeai/octocode-ai";
import {
	type CachePreferenceLayer,
	type CachePreferences,
	cacheEnvironmentPreferences,
	mergeCachePreferences,
} from "@octocodeai/octocode-ai/utils/cache-policy";
import type { ModelsJsonProvider } from "./model-config.ts";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";

/**
 * The retention a headless `--print` run uses when nobody chose one: long instructions (the block every session with
 * the same tools shares) over short history (a one-shot run has no second turn to profit from a one-hour entry).
 * Undefined when a settings layer or the environment set a retention, which then applies as configured.
 */
export function headlessCachePreferences(
	layers: readonly CachePreferenceLayer[],
	env: NodeJS.ProcessEnv,
): CachePreferences | undefined {
	const fromEnv = cacheEnvironmentPreferences(env as ProviderEnv);
	const chosen =
		layers.some(
			({ values }) => values.cacheRetention !== undefined || values.instructionCacheRetention !== undefined,
		) ||
		fromEnv.cacheRetention !== undefined ||
		fromEnv.instructionCacheRetention !== undefined;
	return chosen ? undefined : { cacheRetention: "short", instructionCacheRetention: "long" };
}

export function resolveConfiguredCache(
	model: Model<Api>,
	provider: ModelsJsonProvider | undefined,
	options: StreamOptions = {},
	settings: readonly CachePreferenceLayer[] = [],
) {
	return mergeCachePreferences([
		{ source: "defaults", values: SETTINGS_DEFAULTS },
		...settings,
		{ source: "provider", values: provider ?? {} },
		{ source: "model", values: provider?.models?.find((entry) => entry.id === model.id) ?? {} },
		{ source: "model override", values: provider?.modelOverrides?.[model.id] ?? {} },
		{ source: "environment", values: cacheEnvironmentPreferences(options.env) },
		{ source: "request", values: options },
	]);
}

type Policy = ReturnType<typeof resolveConfiguredCache>["options"];

const NO_CONFIGURABLE_RETENTION = "the retention period is not configurable and is not verified";

/** APIs whose caching the provider manages: no marker or retention field is sent, at most a routing key. */
function describeProviderManaged(api: Api, history: Policy["cacheRetention"]): string | undefined {
	switch (api) {
		case "azure-openai-responses":
		case "openai-codex-responses":
		case "mistral-conversations":
			return history === "none"
				? "No routing key is sent; the provider may still cache automatically."
				: `Provider-managed caching; ${NO_CONFIGURABLE_RETENTION}. A session routing key is sent; short and long behave the same.`;
		case "google-generative-ai":
		case "google-vertex":
			return `Provider-managed implicit caching; ${NO_CONFIGURABLE_RETENTION}. No retention setting is sent.`;
		case "openai-completions":
			return history === "none"
				? "Optional cache writes disabled; the provider may still cache automatically."
				: `Provider-managed caching; ${NO_CONFIGURABLE_RETENTION}. A routing key is sent only where the endpoint supports it.`;
		default:
			return undefined;
	}
}

/** Anthropic marker semantics, shared by Anthropic, Bedrock Claude and OpenRouter Claude. */
function describeMarkers({ cacheRetention: history, instructionCacheRetention: instructions }: Policy, long: boolean) {
	if (history === "none") return "No cache markers are sent, so nothing is written to the cache.";
	const instruction = instructions === "none" ? "no separate write" : instructions === "long" && long ? "1h" : "5m";
	// 1h entries must precede 5m ones, so the adapter sends long history behind 5m instructions at 5m.
	const capped = history === "long" && long && instruction === "5m";
	const historyTtl = capped
		? "5m (1h history cannot follow 5m instructions)"
		: history === "long" && long
			? "1h"
			: "5m";
	let text = `Instructions ${instruction}; history ${historyTtl}. History caching can also cover instructions.`;
	if (!long && (history === "long" || instructions === "long"))
		text += " Long retention is unsupported by this endpoint.";
	return text;
}

function describeOpenAIResponses(model: Model<"openai-responses">, policy: Policy, subscription: boolean): string {
	const { cacheRetention: history, instructionCacheRetention: instructions } = policy;
	if (subscription) return "Subscription credentials: API-only retention controls omitted.";
	const cache = resolveModelCapabilities(model).cache;
	const long = cache.lifetimes.long !== undefined;
	if (cache.mechanism === "explicit-breakpoint") {
		const instruction = instructions === "none" ? undefined : instructions === "long" && long ? "12h" : "30m";
		if (history === "none") {
			return instruction
				? `Explicit mode: only instructions are cached (${instruction}); history is not.`
				: "Explicit mode with no breakpoints: no caching at all, not even the provider's automatic cache.";
		}
		return `Instructions ${instruction ?? "no explicit write"}; history ${history === "long" && long ? "12h" : "30m"}. Implicit history caching can also cover instructions.`;
	}
	if (history === "none") return "No cache key is sent; the provider may still cache automatically.";
	const retention =
		history === "long" && long
			? "24h extended retention requested"
			: `provider-managed retention (${NO_CONFIGURABLE_RETENTION})`;
	return `Implicit caching with a session cache key; ${retention}; separate instruction lifetime is unsupported.`;
}

export function describeCachePolicy(
	model: Model<Api>,
	policy: ReturnType<typeof resolveConfiguredCache>,
	subscription = false,
): string {
	const { cacheRetention: history, instructionCacheRetention: instructions } = policy.options;
	let effective: string;
	const cache = resolveModelCapabilities(model).cache;
	if (cache.mechanism === "markers") {
		effective = describeMarkers(policy.options, cache.lifetimes.long !== undefined);
	} else if (model.api === "openai-responses") {
		effective = describeOpenAIResponses(model as Model<"openai-responses">, policy.options, subscription);
	} else {
		effective =
			describeProviderManaged(model.api, history) ??
			(history === "none"
				? "Optional cache writes disabled; the provider may still cache automatically."
				: "Provider-managed retention; configurable durations are not verified.");
	}
	return `Requested instructions: ${instructions} (${policy.sources.instructionCacheRetention}); history: ${history} (${policy.sources.cacheRetention}).\n${effective}\nCache reads and costs below are provider-reported; retention does not guarantee a hit.`;
}
