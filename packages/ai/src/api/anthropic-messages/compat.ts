import type { CacheControlEphemeral } from "./shapes.ts";
import type { CacheRetention, Model, ProviderEnv } from "../../types.ts";
import { CACHE_PROFILES } from "../../utils/cache-profiles.ts";
import { resolveCacheRetention } from "../../utils/cache-policy.ts";
import { profileCacheFacts } from "../../utils/provider-profile.ts";

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolveCacheRetention(cacheRetention, env);
	if (retention === "none") {
		return { retention };
	}
	const ttl =
		retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention
			? CACHE_PROFILES.anthropic.ttl.long
			: undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

/**
 * Cache controls for the instruction breakpoints (tools and system) and the history breakpoints. Anthropic requires
 * one-hour entries before five-minute ones, and instructions precede history, so five-minute instructions cap
 * one-hour history at five minutes rather than sending a request the API rejects.
 */
export function getLayeredCacheControl(
	model: Model<"anthropic-messages">,
	retention: { history: CacheRetention; instructions: CacheRetention },
	env?: ProviderEnv,
): { instructions?: CacheControlEphemeral; history?: CacheControlEphemeral } {
	const { cacheControl: instructions } = getCacheControl(model, retention.instructions, env);
	const { cacheControl: history } = getCacheControl(model, retention.history, env);
	if (instructions && instructions.ttl !== "1h" && history?.ttl === "1h") {
		return { instructions, history: { type: "ephemeral" } };
	}
	return { instructions, history };
}

/**
 * The 1h tier follows `compat.supportsLongCacheRetention` when a model sets it (catalog entries for hosts that differ
 * from the default, or a custom provider). Otherwise it is host-bound, not model-bound: the provider
 * profile's `longRetention` fact says (Anthropic's API, OpenCode, OpenRouter's Claude models), so a model moved to another baseUrl falls
 * back to the 5-minute tier.
 */
export function getAnthropicCompat(model: Model<"anthropic-messages">) {
	const cache = profileCacheFacts(model);
	const long = cache.longRetention;
	const affinity = cache.sessionAffinity;
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention:
			model.compat?.supportsLongCacheRetention ??
			(long === true || (typeof long === "object" && model.id.startsWith(long.modelPrefix))),
		sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? affinity !== undefined,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? affinity,
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		supportsStrictTools: model.compat?.supportsStrictTools ?? false,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		supportsMidConvoToolChanges: model.compat?.supportsMidConvoToolChanges ?? false,
	};
}
