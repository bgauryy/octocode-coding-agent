import type { Api, Model } from "@octocodeai/octocode-ai";
import { supportsOneHourCache, usesAnthropicMarkers } from "./cache-configuration.ts";
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
 * subagent receives its parent's choice) or the request set stays as configured. Only models with Anthropic-style
 * markers that accept a one-hour tier are affected, and only when the instructions are already long-lived, so the
 * history marker does not follow a shorter one. The first request never counts as an idle gap.
 */
export class IdleHistoryCache {
	private lastRequestAt: number | undefined;
	private idleSeen = false;

	/** Records a request about to be sent and returns the policy options to send it with. */
	apply(model: Model<Api>, policy: ResolvedCache, now: number = Date.now()): ResolvedCache["options"] {
		if (this.lastRequestAt !== undefined && now - this.lastRequestAt > SHORT_HISTORY_TTL_MS) this.idleSeen = true;
		this.lastRequestAt = now;
		const { options, sources } = policy;
		if (
			!this.idleSeen ||
			options.cacheRetention !== "short" ||
			options.instructionCacheRetention !== "long" ||
			sources.cacheRetention !== "defaults" ||
			!usesAnthropicMarkers(model) ||
			!supportsOneHourCache(model)
		) {
			return options;
		}
		return { ...options, cacheRetention: "long" };
	}
}
