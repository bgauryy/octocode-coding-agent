/**
 * Which Bedrock models a capability applies to, decided from the model ID and name (application inference profiles
 * hide the name in their ARN). Free of the AWS SDK so model capabilities can be resolved without loading it.
 */
import type { Model, ProviderEnv } from "../../types.ts";
import { CACHE_PROFILES, type CacheProfile } from "../../utils/cache-profiles.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";

/** Separators in free-text profile names and vendor ids ("Claude Sonnet 4.5", "anthropic/claude-sonnet-4@20250514"). */
const NAME_SEPARATORS = /[\s_.:@/]+/g;

/**
 * The lowercase model ID and name, each also with its separators turned into "-". Checks both so application
 * inference profiles, whose ARNs don't contain the model name, match by name.
 */
export function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
	const values = modelName ? [modelId, modelName] : [modelId];
	return values.flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(NAME_SEPARATORS, "-")];
	});
}

/** Claude 5 model-name tokens (Bedrock ids and display names), matched as substrings of a normalized candidate. */
const CLAUDE_5_TOKENS = ["fable-5", "opus-5", "sonnet-5", "haiku-5"] as const;

function isClaude5Candidate(candidate: string): boolean {
	return CLAUDE_5_TOKENS.some((token) => candidate.includes(token));
}

export function supportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
	const candidates = getModelMatchCandidates(modelId, modelName);
	return candidates.some(
		(s) =>
			s.includes("opus-4-6") ||
			s.includes("opus-4-7") ||
			s.includes("opus-4-8") ||
			s.includes("sonnet-4-6") ||
			isClaude5Candidate(s),
	);
}

/**
 * Check if the model is an Anthropic Claude model on Bedrock.
 * Checks both model ID and model name to support application inference profiles
 * whose ARNs don't contain the model name.
 */
export function isAnthropicClaudeModel(model: Model<"bedrock-converse-stream">): boolean {
	const id = model.id.toLowerCase();
	const name = model.name?.toLowerCase() ?? "";
	// A name containing "claude" covers its `anthropic.claude` and `anthropic/claude` forms too.
	return id.includes("anthropic.claude") || id.includes("anthropic/claude") || name.includes("claude");
}

/**
 * Amazon Nova models that take explicit cache checkpoints, per "Supported models, Regions, and explicit caching limits"
 * (https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html, fetched 2026-11-08): Nova 2 Lite, Nova Pro,
 * Nova Lite and Nova Micro, on `system` and `messages` only (not `tools`), with the 5-minute TTL only, at most four
 * checkpoints and at most 20K cached tokens. Other Nova models (Premier) keep implicit caching.
 */
const NOVA_EXPLICIT_CACHE_TOKENS = ["nova-2-lite-v1", "nova-pro-v1", "nova-lite-v1", "nova-micro-v1"] as const;

function isNovaExplicitCacheModel(model: Pick<Model<"bedrock-converse-stream">, "id" | "name">): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);
	return candidates.some((candidate) => NOVA_EXPLICIT_CACHE_TOKENS.some((token) => candidate.includes(token)));
}

/**
 * Check if the model supports prompt caching.
 * Supported: Claude 3.5 Haiku, Claude 3.7 Sonnet, Claude 4.x models, Claude 5 models
 *
 * For base models and system-defined inference profiles the model ID / ARN
 * contains the model name, so we can decide locally.
 *
 * For application inference profiles (whose ARNs don't contain the model name),
 * also checks model.name which is user-controlled via models.json or registerProvider.
 * As a last resort, set AWS_BEDROCK_FORCE_CACHE=1 to enable cache points. A profile that matches neither gets a
 * one-time `cache_unavailable` diagnostic on its reply ({@link isUnrecognizedCacheProfile}).
 * Amazon Nova models AWS lists for explicit caching take cache points too ({@link isNovaExplicitCacheModel}).
 */
export function supportsPromptCaching(model: Model<"bedrock-converse-stream">, env?: ProviderEnv): boolean {
	if (isNovaExplicitCacheModel(model)) return true;
	const candidates = getModelMatchCandidates(model.id, model.name);

	const hasClaudeRef = candidates.some((s) => s.includes("claude"));
	if (!hasClaudeRef) {
		// Application inference profiles don't contain the model name in the ARN.
		// Allow users to force cache points via environment variable.
		if (getProviderEnvValue("AWS_BEDROCK_FORCE_CACHE", env) === "1") return true;
		return false;
	}
	// Claude 5 models (fable-5, opus-5, sonnet-5, haiku-5)
	if (candidates.some(isClaude5Candidate)) return true;
	// Claude 4.x models (opus-4, sonnet-4, haiku-4); a profile name such as "Claude Sonnet 4" ends in "-4".
	if (candidates.some((s) => s.includes("-4-") || s.endsWith("-4"))) return true;
	if (candidates.some((s) => s.includes("claude-3-7-sonnet"))) return true;
	if (candidates.some((s) => s.includes("claude-3-5-haiku"))) return true;
	return false;
}

/** An application inference profile's ARN, which names no model: only the profile's `name` can. */
const APPLICATION_PROFILE_ARN = /:application-inference-profile\//;

/**
 * Whether `model` is an application inference profile that gets no cache points because neither its ARN nor its name
 * names a model that takes them: the one case where caching is off for a reason the user's models.json can fix (a
 * `name` such as "Claude Sonnet 4.5", see {@link supportsPromptCaching}).
 */
export function isUnrecognizedCacheProfile(model: Model<"bedrock-converse-stream">, env?: ProviderEnv): boolean {
	return APPLICATION_PROFILE_ARN.test(model.id) && !supportsPromptCaching(model, env);
}

/**
 * Claude models on Bedrock that accept only five-minute cache points: Sonnet 4, Opus 4, Opus 4.1 and Claude 3.x, in
 * Bedrock ids, display names and Anthropic aliases ("claude-sonnet-4-0"). The "Supported TTL" column of the AWS model
 * cards (fetched 2026-11-08) is the source: Sonnet 4 and Opus 4.1 list "5 minutes"
 * (https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4.html,
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-1.html), Sonnet 4.5 lists
 * "5 minutes, 1 hour" (https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-5.html),
 * and https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html lists one hour for Claude 5.x, Opus 4.5
 * and later, Sonnet 4.6 and later and Haiku 4.5. Claude 3.x is classified as five-minute-only by its absence from that
 * one-hour table, not by a model-card quote. A `ttl` on a five-minute-only model can be rejected with a
 * ValidationException. Unknown and newer models keep the one-hour TTL.
 */
const FIVE_MINUTE_ONLY_CLAUDE = /(?:sonnet|opus)-4(?:-0(?!\d)|-20\d{6}|(?!-\d))|opus-4-1(?!\d)|claude-3-/;

function supportsOneHourCacheTtl(modelId: string, modelName?: string): boolean {
	// Only the separator-normalized forms: in a raw "claude-sonnet-4.5" the "sonnet-4" is followed by "." and would match.
	const normalized = getModelMatchCandidates(modelId, modelName).map((value) => value.replace(NAME_SEPARATORS, "-"));
	return !normalized.some((candidate) => FIVE_MINUTE_ONLY_CLAUDE.test(candidate));
}

/**
 * Whether long retention sends one-hour cache points. An explicit `compat.supportsLongCacheRetention` decides;
 * otherwise the model rule does ({@link supportsOneHourCacheTtl}). The adapter and the model capabilities both use it.
 */
export function bedrockSupportsLongCacheRetention(model: Model<"bedrock-converse-stream">): boolean {
	return (
		model.compat?.supportsLongCacheRetention ??
		(isAnthropicClaudeModel(model) && !isNovaExplicitCacheModel(model) && supportsOneHourCacheTtl(model.id, model.name))
	);
}

/** The cache profile of a Bedrock model: Claude and listed Nova models take markers, every other model none. */
export function bedrockCacheProfile(model: Model<"bedrock-converse-stream">, env?: ProviderEnv): CacheProfile {
	if (isNovaExplicitCacheModel(model)) return CACHE_PROFILES.bedrockNova;
	return supportsPromptCaching(model, env) ? CACHE_PROFILES.bedrockClaude : CACHE_PROFILES.bedrockOther;
}
