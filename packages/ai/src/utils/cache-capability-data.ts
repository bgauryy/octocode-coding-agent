/**
 * Prompt-cache facts that are not per model: the Anthropic-protocol hosts and the OpenRouter prefix that verify the 1h
 * tier, and the shape of the per-model flag table. The model generator owns the per-model facts
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

/**
 * Anthropic-protocol hosts whose documentation verifies the 1h tier through `cache_control.ttl`: Anthropic's own API, and
 * OpenCode, which serves Claude through Anthropic's API and bills 1h writes separately (its non-Claude models opt out
 * in their metadata). OpenRouter verifies it for its Claude models only (`OPENROUTER_LONG_CACHE_MODEL_PREFIX`). Every
 * other host (Vercel, Cloudflare, Copilot, MiniMax and other gateways) stays on the 5-minute tier unless a model sets
 * `compat.supportsLongCacheRetention: true`.
 */
export const ANTHROPIC_LONG_CACHE_HOSTS: readonly string[] = ["api.anthropic.com", "opencode.ai"];

/**
 * OpenRouter model ids with the 1h tier: "Cache writes (1-hour TTL): charged at 2x the price of the original input
 * pricing" for Anthropic Claude. Verified 2026-11-19: https://openrouter.ai/docs/guides/best-practices/prompt-caching
 */
export const OPENROUTER_LONG_CACHE_MODEL_PREFIX = "anthropic/";
