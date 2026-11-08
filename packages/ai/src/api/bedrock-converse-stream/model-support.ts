import { CacheTTL } from "@aws-sdk/client-bedrock-runtime";
import type { CacheRetention, Model, SimpleStreamOptions } from "../../types.ts";
import { bedrockSupportsLongCacheRetention, getModelMatchCandidates, isAnthropicClaudeModel } from "./model-match.ts";

function supportsNativeXhighEffort(model: Model<"bedrock-converse-stream">): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);
	return candidates.some(
		(s) =>
			s.includes("opus-4-7") ||
			s.includes("opus-4-8") ||
			s.includes("opus-5") ||
			s.includes("sonnet-5") ||
			s.includes("haiku-5") ||
			s.includes("fable-5"),
	);
}

/**
 * Check if the model accepts `thinking.block_binding`. Opus 4.6 and Sonnet 4.6 reject it with
 * "thinking.adaptive.block_binding: Extra inputs are not permitted".
 */
export function supportsThinkingBlockBinding(model: Model<"bedrock-converse-stream">): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);
	return candidates.some(
		(s) =>
			s.includes("opus-4-7") ||
			s.includes("opus-4-8") ||
			s.includes("opus-5") ||
			s.includes("sonnet-5") ||
			s.includes("haiku-5") ||
			s.includes("fable-5"),
	);
}

export function mapThinkingLevelToEffort(
	model: Model<"bedrock-converse-stream">,
	level: SimpleStreamOptions["reasoning"],
): "low" | "medium" | "high" | "xhigh" | "max" {
	if (level === "xhigh" && supportsNativeXhighEffort(model)) return "xhigh";

	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as "low" | "medium" | "high" | "xhigh" | "max";

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

/** One-hour cache points for long retention on models that accept them ({@link bedrockSupportsLongCacheRetention}). */
export function longCacheTtl(
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): { ttl?: CacheTTL } {
	return cacheRetention === "long" && bedrockSupportsLongCacheRetention(model) ? { ttl: CacheTTL.ONE_HOUR } : {};
}

/**
 * Check if the model supports thinking signatures in reasoningContent.
 * Only Anthropic Claude models support the signature field.
 * Other models (OpenAI, Qwen, Minimax, Moonshot, etc.) reject it with:
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 *
 * Checks both model ID and model name to support application inference profiles.
 */
export function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
	return isAnthropicClaudeModel(model);
}
