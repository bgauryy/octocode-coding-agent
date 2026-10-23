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
