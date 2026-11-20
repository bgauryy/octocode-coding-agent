import {
	type Api,
	calculateCost,
	type Context,
	getCurrentSystemMessage,
	getSystemMessageText,
	type Model,
	normalizeContext,
	resolveModelCapabilities,
	replaysWithReasoningUnchanged,
	type SimpleStreamOptions,
	type Usage,
} from "@octocodeai/octocode-ai";
import { createEmptyUsage } from "@octocodeai/octocode-ai/utils/assistant-message";
import { resolveCacheRetention, resolveInstructionCacheRetention } from "@octocodeai/octocode-ai/utils/cache-policy";
import { charsToTokens } from "@octocodeai/octocode-ai/utils/estimate";
import type { SessionEntry } from "../session-manager.ts";

/** Streaming warming never continues past this long after the real request that started it. */
export const MAX_WARMING_AGE_MS = 60 * 60_000;
/** Idle warming uses a shorter horizon because continuation estimates become less reliable with age. */
const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000;
/**
 * How long after its start an idle run may still refresh: the idle horizon, or one lifetime when the entry lives longer,
 * so a one-hour entry gets the one refresh that falls at 90% of its lifetime instead of none.
 */
export function idleWarmingLimitMs(ttlMs: number): number {
	return Math.max(MAX_IDLE_WARMING_AGE_MS, ttlMs);
}
/**
 * A refresh is sent only when it is expected to save at least this many dollars. The chance that an idle refresh is
 * used comes from measured idle gaps (`idle-pool.ts`), pooled across sessions, not from a constant.
 */
export const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;

/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */
export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
	if (!Number.isFinite(ttlMs) || ttlMs <= 10_000) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

const validSeconds = (seconds: number | undefined): seconds is number =>
	seconds !== undefined && Number.isFinite(seconds) && seconds > 0;

interface PromptCacheLifetime {
	/** Lifetime of the shortest-lived entry the request writes: the history entry. */
	ttlMs: number;
	/**
	 * True when the instructions are written with a longer lifetime than the history. When the history entry
	 * expires, the instruction prefix is still read from its own entry, so only the history is rewritten.
	 */
	layered: boolean;
	/** The tier the history is written at, which prices its rewrite. */
	history: "short" | "long";
}

/**
 * Lifetimes of the prompt cache entries a request writes, for the retention pair the request used: the model's resolved
 * cache tiers (`resolveModelCapabilities`), which take a declared `promptCache` lifetime first and otherwise the lifetime
 * the adapter sends, and have no long tier where the adapter sends none (a marker adapter then sends long history at the
 * short lifetime). Undefined when the model has no lifetime for that tier or caching is off.
 */
export function getPromptCacheLifetime(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
): PromptCacheLifetime | undefined {
	const retention = resolveCacheRetention(options?.cacheRetention, options?.env);
	if (retention === "none") return undefined;
	const instructions = resolveInstructionCacheRetention(options);
	// Adapters with Anthropic-style markers send long history behind short instructions at the short lifetime; that is
	// the safe lifetime to plan with for any provider.
	const { mechanism, lifetimes, longInstructionsOnly } = resolveModelCapabilities(model, options?.env).cache;
	// A marker adapter also sends long history at the short lifetime where the endpoint has no long tier, and OpenAI
	// explicit mode keeps the history on the request's short TTL (its long tier is for instruction breakpoints).
	const history =
		(instructions === "short" && retention === "long") ||
		(mechanism === "markers" && lifetimes.long === undefined) ||
		longInstructionsOnly
			? "short"
			: retention;
	const seconds = lifetimes[history];
	if (!validSeconds(seconds)) return undefined;
	// Legacy options leave the instructions to follow a long history; explicit mode then marks them at the long tier.
	const instructionTier = instructions ?? (longInstructionsOnly ? retention : undefined);
	const layered =
		instructionTier === "long" && history === "short" && validSeconds(lifetimes.long) && lifetimes.long > seconds;
	return { ttlMs: seconds * 1000, layered, history };
}

/** Lifetime of the history entry, the first one a request's cache loses. See {@link getPromptCacheLifetime}. */
export function getPromptCacheTtlMs(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
	return getPromptCacheLifetime(model, options)?.ttlMs;
}

/**
 * Token estimate of the instruction prefix (current system prompt and tool declarations) that an instruction cache
 * breakpoint covers, at the dense end of the model family's measured ratio (`charsPerToken`). Over-estimating it
 * under-estimates the history a miss would rewrite, so layered warming errs toward not refreshing.
 */
export function estimateInstructionPrefixTokens(context: Context, model?: Pick<Model<Api>, "id">): number {
	const system = getCurrentSystemMessage(normalizeContext(context).messages);
	if (!system) return 0;
	return charsToTokens(
		getSystemMessageText(system).length + (system.toolsAdded?.length ? JSON.stringify(system.toolsAdded).length : 0),
		model,
	);
}

/**
 * Whether replaying the request with a one-token output cap leaves its cache entry untouched. Where the reasoning
 * budget derives from the output cap (Anthropic budget thinking, Bedrock), the replay would get a different budget,
 * which the message cache is keyed on, and the model could still think for thousands of tokens. The model's resolved
 * capabilities decide; an API they do not know is treated as not replayable.
 */
export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
	return !options?.reasoning || replaysWithReasoningUnchanged(model);
}

/** Reported reusable prefix and uncached tail of the latest real request. */
export function lastPromptTokens(entries: SessionEntry[]): { cached: number; input: number } {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			return { cached: usage.cacheRead + usage.cacheWrite, input: usage.input };
		}
	}
	return { cached: 0, input: 0 };
}

export function price(
	model: Model<Api>,
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "cacheWrite12h">>,
): number {
	const usage: Usage = { ...createEmptyUsage(), ...tokens };
	return calculateCost(model, usage).total;
}
