import { type Api, type Model, resolveModelCapabilities } from "@octocodeai/octocode-ai";
import type { resolveConfiguredCache } from "./cache-configuration.ts";

/** How long a short-lived history cache entry lasts: a gap between requests above this found it already expired. */
export const SHORT_HISTORY_TTL_MS = 5 * 60_000;

type ResolvedCache = ReturnType<typeof resolveConfiguredCache>;

/**
 * Moves a session's history cache from the 5-minute tier to the 1-hour tier once it has idled past the 5-minute
 * lifetime. A session that pauses between turns pays a full history rewrite after every pause; one hour of retention
 * costs a little more per write but spares those rewrites. A session that never pauses never pays for it.
 *
 * Only the application default is changed: a retention the user, a model definition, the environment (which is how a
 * subagent receives the retention resolved for it at launch) or the request set stays as configured. Only models with
 * Anthropic-style markers that accept a one-hour tier are affected, and only when the instructions are already
 * long-lived, so the history marker does not follow a shorter one. The first request never counts as an idle gap.
 *
 * The caller passes only the session's own requests, after virtual routing: compaction and summary requests have
 * their own cache entries, so they neither measure the gap nor move to the long tier.
 */
export class IdleHistoryCache {
	private lastRequestAt: number | undefined;
	private idleSeen = false;

	/** Records a request about to be sent and returns the policy options to send it with. */
	apply(model: Model<Api>, policy: ResolvedCache, now: number = Date.now()): ResolvedCache["options"] {
		if (this.lastRequestAt !== undefined && now - this.lastRequestAt > SHORT_HISTORY_TTL_MS) this.idleSeen = true;
		this.lastRequestAt = now;
		return this.idleSeen ? IdleHistoryCache.afterIdle(model, policy) : policy.options;
	}

	/** The options a request sent after an idle gap uses; the history it rewrites is priced at this tier. */
	static afterIdle(model: Model<Api>, policy: ResolvedCache): ResolvedCache["options"] {
		const { options, sources } = policy;
		if (
			options.cacheRetention !== "short" ||
			options.instructionCacheRetention !== "long" ||
			sources.cacheRetention !== "defaults" ||
			!hasLongMarkers(model)
		) {
			return options;
		}
		return { ...options, cacheRetention: "long" };
	}
}

/** Anthropic-style markers with a one-hour tier: the only caches whose history can move to the long tier. */
function hasLongMarkers(model: Model<Api>): boolean {
	const { cache } = resolveModelCapabilities(model);
	return cache.mechanism === "markers" && cache.lifetimes.long !== undefined;
}
