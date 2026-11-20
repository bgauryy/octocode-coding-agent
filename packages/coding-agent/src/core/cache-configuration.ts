import { type Api, type Model, resolveModelCapabilities, type StreamOptions } from "@octocodeai/octocode-ai";
import {
	azureAcceptsExtendedRetention,
	azureInstructionCacheTtl,
	azureSupportsExplicitPromptCacheMode,
} from "@octocodeai/octocode-ai/api/azure-openai-config";
import {
	type CachePreferenceLayer,
	cacheEnvironmentPreferences,
	mergeCachePreferences,
} from "@octocodeai/octocode-ai/utils/cache-policy";
import type { ModelsJsonProvider } from "./model-config.ts";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";

/** Anthropic's own API: the one host whose long cache tier needs no declaration. */
const ANTHROPIC_ORIGIN = "https://api.anthropic.com";

function onAnthropicHost(model: Model<Api>): boolean {
	try {
		return new URL(model.baseUrl).origin === ANTHROPIC_ORIGIN;
	} catch {
		return false;
	}
}

/**
 * The long tier is the default only where the endpoint is known to honour it. An Anthropic-style model that
 * `models.json` defines or moves to a host other than Anthropic's starts at the short tier unless it declares
 * `compat.supportsLongCacheRetention: true`; an explicit preference still wins. Re-declaring a model on Anthropic's own
 * host keeps the long default.
 */
function defaultCachePreferences(model: Model<Api>, provider: ModelsJsonProvider | undefined) {
	if (model.api !== "anthropic-messages" || !provider || onAnthropicHost(model)) return SETTINGS_DEFAULTS;
	const configured = provider.baseUrl !== undefined || provider.models?.some((entry) => entry.id === model.id);
	const declared = (model as Model<"anthropic-messages">).compat?.supportsLongCacheRetention === true;
	if (!configured || declared) return SETTINGS_DEFAULTS;
	const short = (retention: NonNullable<StreamOptions["cacheRetention"]>) =>
		retention === "long" ? "short" : retention;
	return {
		cacheRetention: short(SETTINGS_DEFAULTS.cacheRetention),
		instructionCacheRetention: short(SETTINGS_DEFAULTS.instructionCacheRetention),
	};
}

export function resolveConfiguredCache(
	model: Model<Api>,
	provider: ModelsJsonProvider | undefined,
	options: StreamOptions = {},
	settings: readonly CachePreferenceLayer[] = [],
) {
	return mergeCachePreferences([
		{ source: "defaults", values: defaultCachePreferences(model, provider) },
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

/** OpenAI Responses, and Azure OpenAI Responses on a model that accepts the 24h tier (the key path only). */
function describeOpenAIResponses(model: Model<Api>, policy: Policy, subscription: boolean): string {
	const { cacheRetention: history, instructionCacheRetention: instructions } = policy;
	if (subscription) return "Subscription credentials: API-only retention controls omitted.";
	const cache = resolveModelCapabilities(model).cache;
	const long = cache.lifetimes.long !== undefined;
	if (cache.mechanism === "explicit-breakpoint" && model.api === "azure-openai-responses") {
		// Azure breakpoints carry no TTL of their own: the request TTL, the longer of the two tiers, covers them and the history.
		if (history === "none")
			return "Explicit mode with no breakpoints: no caching at all, not even the provider's automatic cache.";
		const ttl = long && (history === "long" || instructions === "long") ? "12h" : "30m";
		const covers = instructions === "none" ? "history" : "instruction breakpoints and history";
		return `Explicit mode opted in; request TTL ${ttl} covers ${covers}.`;
	}
	if (cache.mechanism === "explicit-breakpoint") {
		const instruction = instructions === "none" ? undefined : instructions === "long" && long ? "12h" : "30m";
		if (history === "none") {
			return instruction
				? `Explicit mode: only instructions are cached (${instruction}); history is not.`
				: "Explicit mode with no breakpoints: no caching at all, not even the provider's automatic cache.";
		}
		const historyTtl =
			history === "long" && long && !cache.longInstructionsOnly
				? "12h"
				: history === "long" && long
					? "30m (the 12h tier goes on instruction breakpoints only)"
					: "30m";
		return `Instructions ${instruction ?? "no explicit write"}; history ${historyTtl}. Implicit history caching can also cover instructions.`;
	}
	if (history === "none") return "No cache key is sent; the provider may still cache automatically.";
	const retention =
		(history === "long" || instructions === "long") && long
			? "24h extended retention requested (typically about 30 minutes, planned as such)"
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
	} else if (
		model.api === "openai-responses" ||
		(model.api === "azure-openai-responses" &&
			(azureSupportsExplicitPromptCacheMode(model) || azureAcceptsExtendedRetention(model)))
	) {
		effective = describeOpenAIResponses(model, policy.options, subscription);
	} else {
		effective =
			describeProviderManaged(model.api, history) ??
			(history === "none"
				? "Optional cache writes disabled; the provider may still cache automatically."
				: "Provider-managed retention; configurable durations are not verified.");
		// GPT-6 Astra on Azure: explicit breakpoints on the instructions, in implicit mode.
		const instructionTtl =
			model.api === "azure-openai-responses" ? azureInstructionCacheTtl(model, policy.options) : undefined;
		if (instructionTtl) effective += ` Instructions carry a ${instructionTtl} cache breakpoint.`;
	}
	return `Requested instructions: ${instructions} (${policy.sources.instructionCacheRetention}); history: ${history} (${policy.sources.cacheRetention}).\n${effective}\nCache reads and costs below are provider-reported; retention does not guarantee a hit.`;
}
