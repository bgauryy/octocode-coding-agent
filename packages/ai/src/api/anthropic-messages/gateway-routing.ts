import type { Model, StreamOptions } from "../../types.ts";
import { resolveCacheAffinityId } from "../../utils/cache-policy.ts";

/**
 * The `providerOptions.gateway` object for a request, or undefined when the model sets no gateway routing. The model's
 * routing is copied, never shared, so a session id added for one request cannot leak into another. A routing object
 * that names its own `sessionId` keeps it.
 */
export function vercelGatewayOptions(
	model: Model<"anthropic-messages"> | Model<"openai-completions">,
	options: Pick<StreamOptions, "sessionId" | "promptCacheKey" | "cacheRetention" | "env">,
): Record<string, unknown> | undefined {
	const routing = model.compat?.vercelGatewayRouting;
	if (!routing || Object.keys(routing).length === 0) return undefined;
	const gateway: Record<string, unknown> = structuredClone(routing);
	const sessionId = resolveCacheAffinityId(options);
	if (sessionId && gateway.sessionId === undefined && gateway.sessionAffinity !== false) gateway.sessionId = sessionId;
	return gateway;
}
