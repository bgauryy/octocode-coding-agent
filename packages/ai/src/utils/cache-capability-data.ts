/**
 * Prompt-cache facts the providers document per model or host, as data. `withCacheCapabilities` stamps them into
 * `model.compat` when the catalog is generated and loaded; adapters read only the resolved compat flags, never these
 * lists. A model missing here, or with its own compat value, gets the safe default: no explicit mode, no long tier,
 * no instruction breakpoints, no cache markers. A new model that needs a capability either joins a list below or sets
 * the compat flag itself (models.json `compat`).
 */

/** OpenAI ids (dated snapshots included) that take `prompt_cache_options` instead of `prompt_cache_retention`. Verified 2026-11-08: https://developers.openai.com/api/docs/guides/prompt-caching */
export const OPENAI_EXPLICIT_CACHE_MODELS: ReadonlySet<string> = new Set([
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.6-cyber",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
	"gpt-daybreak-blue-latest",
	"gpt-daybreak-red-latest",
]);

/**
 * Azure ids that take 30m breakpoints on every deployment type. GPT-6 Astra does on Standard and PTU-M; earlier
 * models, GPT-5.6 included, reject breakpoints on provisioned deployments, so Azure cannot assume them from the
 * explicit list above.
 */
export const AZURE_INSTRUCTION_BREAKPOINT_MODELS: ReadonlySet<string> = new Set(["gpt-6-astra"]);

/** OpenAI ids that accept `prompt_cache_retention: "24h"` on api.openai.com. Verified 2026-11-10: https://developers.openai.com/api/docs/guides/prompt-caching */
export const OPENAI_EXTENDED_RETENTION_MODELS: ReadonlySet<string> = new Set([
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

/** Azure ids that accept `prompt_cache_retention: "24h"`. Verified 2026-11-08: https://learn.microsoft.com/azure/foundry/openai/how-to/prompt-caching */
export const AZURE_EXTENDED_RETENTION_MODELS: ReadonlySet<string> = new Set([
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

/**
 * OpenRouter ids whose caching its docs say needs explicit `cache_control` breakpoints with a fixed 5-minute TTL
 * (Alibaba). Snapshot endpoints such as `qwen/qwen3.5-plus-02-15` are excluded there, so ids match exactly.
 * https://openrouter.ai/docs/guides/best-practices/prompt-caching#alibaba-qwen
 */
export const OPENROUTER_EXPLICIT_MARKER_MODELS: ReadonlySet<string> = new Set([
	"deepseek/deepseek-v3.2",
	"qwen/qwen3-max",
	"qwen/qwen-plus",
	"qwen/qwen3.6-plus",
	"qwen/qwen3-coder-plus",
	"qwen/qwen3-coder-flash",
]);

/**
 * Anthropic-protocol hosts whose documentation verifies the 1h tier through `cache_control.ttl`: Anthropic's own API, and
 * OpenCode, which serves Claude through Anthropic's API and bills 1h writes separately (its non-Claude models opt out
 * in their metadata). Every other host (OpenRouter, Vercel, Cloudflare, Copilot, MiniMax and other gateways) stays on
 * the 5-minute tier unless a model sets `compat.supportsLongCacheRetention: true`.
 */
export const ANTHROPIC_LONG_CACHE_HOSTS: readonly string[] = ["api.anthropic.com", "opencode.ai"];
