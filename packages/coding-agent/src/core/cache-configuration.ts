import type { Api, Model, StreamOptions } from "@octocodeai/octocode-ai";
import {
	type CachePreferenceLayer,
	cacheEnvironmentPreferences,
	mergeCachePreferences,
} from "@octocodeai/octocode-ai/utils/cache-policy";
import type { ModelsJsonProvider } from "./model-config.ts";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";

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

export function describeCachePolicy(
	model: Model<Api>,
	policy: ReturnType<typeof resolveConfiguredCache>,
	subscription = false,
): string {
	const { cacheRetention: history, instructionCacheRetention: instructions } = policy.options;
	let effective = "Provider-managed retention; configurable durations are not verified.";
	if (history === "none") effective = "Optional cache writes disabled; the provider may still cache automatically.";
	else if (model.api === "anthropic-messages") {
		const long = (model as Model<"anthropic-messages">).compat?.supportsLongCacheRetention !== false;
		effective = `Instructions ${instructions === "none" ? "no separate write" : instructions === "long" && long ? "1h" : "5m"}; history ${history === "long" && long ? "1h" : "5m"}. History caching can also cover instructions.`;
		if (!long && (history === "long" || instructions === "long"))
			effective += " Long retention is unsupported by this endpoint.";
	} else if (model.api === "openai-responses") {
		const compat = (model as Model<"openai-responses">).compat;
		if (subscription) effective = "Subscription credentials: API-only retention controls omitted.";
		else if (compat?.supportsExplicitPromptCacheMode) {
			const long =
				compat.supportsLongCacheRetention ??
				(model.provider === "openai" || new URL(model.baseUrl).hostname === "api.openai.com");
			effective = `Instructions ${instructions === "none" ? "no explicit write" : instructions === "long" && long ? "12h" : "30m"}; history 30m. Implicit history caching can also cover instructions.`;
		} else effective = "Legacy or provider-managed caching; separate instruction lifetime is unsupported.";
	}
	return `Requested instructions: ${instructions} (${policy.sources.instructionCacheRetention}); history: ${history} (${policy.sources.cacheRetention}).\n${effective}\nCache reads and costs below are provider-reported; retention does not guarantee a hit.`;
}
