/**
 * The shape of the per-model prompt-cache flag table. Facts that belong to a provider family (which hosts verify the 1h
 * tier, which ids take markers) live in the provider profile table (`provider-profile-data.ts`). The model generator owns the per-model facts
 * (`scripts/generate-models/cache-flags.ts`) and writes them to `cache-capability-flags.generated.ts`;
 * `withCacheCapabilities` stamps them into `model.compat` when the catalog is generated and loaded. Adapters read only
 * the resolved compat flags. A model without a flag, or with its own compat value, gets the safe default: no explicit
 * mode, no long tier, no instruction breakpoints, no cache markers. A custom model that needs a capability sets the
 * compat flag itself (models.json `compat`).
 */

/** What a provider documents for one model id. */
export interface ModelCacheFlags {
	/** Takes `prompt_cache_options` (explicit breakpoints) instead of `prompt_cache_retention`. */
	readonly explicitMode?: true;
	/** Accepts `prompt_cache_retention: "24h"`. */
	readonly longRetention?: true;
	/** Azure only: takes 30m breakpoints on every deployment type. */
	readonly instructionBreakpoints?: true;
	/** OpenRouter only: caches only behind explicit `cache_control` markers with a fixed 5-minute TTL. */
	readonly explicitMarkers?: true;
}

/** Flags by id for each host the facts cover: api.openai.com, Azure OpenAI and OpenRouter. */
export interface CacheFlagTable {
	readonly openai: Readonly<Record<string, ModelCacheFlags>>;
	readonly azure: Readonly<Record<string, ModelCacheFlags>>;
	readonly openrouter: Readonly<Record<string, ModelCacheFlags>>;
}
