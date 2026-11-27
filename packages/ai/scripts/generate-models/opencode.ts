import type { AnthropicMessagesCompat, ModelPromptCache } from "../../src/types.ts";

/** OpenCode Zen and Go: prompt-cache metadata for models served through the Anthropic Messages endpoint. */

// The gateway serves Claude through Anthropic's API and bills 5-minute and 1-hour cache writes
// separately (`usage.opencode.tokens.cache_write_5m` / `cache_write_1h`), so Claude keeps
// Anthropic's lifetimes and the cache warmer can plan around them.
// https://github.com/anomalyco/opencode/blob/f20760b8bf3bced0fa5620b6afe7b78dd615ee36/services/www/src/docs/content/console/api/inference.mdx
const OPENCODE_CLAUDE_PROMPT_CACHE: ModelPromptCache = { short: 300, long: 3600 };

// Other models on that endpoint (Qwen, MiniMax) accept `cache_control` markers but have no
// 1-hour tier; Alibaba documents a fixed 5-minute explicit cache. Their markers omit `ttl`.
// https://www.alibabacloud.com/help/en/model-studio/context-cache
const OPENCODE_NON_CLAUDE_ANTHROPIC_COMPAT: AnthropicMessagesCompat = { supportsLongCacheRetention: false };

export function getOpenCodeAnthropicCacheMetadata(modelId: string): {
	promptCache?: ModelPromptCache;
	compat?: AnthropicMessagesCompat;
} {
	return modelId.startsWith("claude-")
		? { promptCache: OPENCODE_CLAUDE_PROMPT_CACHE }
		: { compat: OPENCODE_NON_CLAUDE_ANTHROPIC_COMPAT };
}
