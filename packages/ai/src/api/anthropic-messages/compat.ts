import type { BetaCacheControlEphemeral as CacheControlEphemeral } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { CacheRetention, Model, ProviderEnv } from "../../types.ts";
import { resolveCacheRetention } from "../../utils/cache-policy.ts";

export function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolveCacheRetention(cacheRetention, env);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
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

export function shouldUseServerSideFallbackBeta(model: Model<"anthropic-messages">): boolean {
	return (model.compat?.allowedFallbackModels?.length ?? 0) > 0;
}

export function getAnthropicCompat(model: Model<"anthropic-messages">) {
	const isOpenRouter = model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? isOpenRouter,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? (isOpenRouter ? "openrouter" : undefined),
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		supportsStrictTools: model.compat?.supportsStrictTools ?? false,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		supportsMidConvoToolChanges: model.compat?.supportsMidConvoToolChanges ?? false,
	};
}
