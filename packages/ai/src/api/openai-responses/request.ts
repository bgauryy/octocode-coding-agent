import type { Model, ProviderEnv, ProviderHeaders, TranscriptContext } from "../../types.ts";
import { providerHeadersToRecord } from "../../utils/headers.ts";
import { getUserAgent } from "../../utils/user-agent.ts";
import { openAIEnvironmentHeaders } from "../openai-environment-headers.ts";
import { copilotDynamicHeadersFor } from "../github-copilot-headers.ts";
import { getProviderCapabilities } from "../../utils/provider-capabilities.ts";
import { getCompat } from "./compat.ts";
export { applyServiceTierPricing } from "../openai-responses-shared/service-tier.ts";

export function createRequestHeaders(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	sessionId?: string,
	env?: ProviderEnv,
) {
	const compat = getCompat(model);
	const headers: ProviderHeaders =
		providerHeadersToRecord(
			{
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				Authorization: `Bearer ${apiKey}`,
			},
			openAIEnvironmentHeaders(env),
			{ "User-Agent": getUserAgent() },
			model.headers,
		) ?? {};
	Object.assign(headers, copilotDynamicHeadersFor(model.provider, context.messages));
	if (sessionId) {
		if (compat.sessionAffinityFormat === "openrouter") headers["x-session-id"] = sessionId;
		else {
			if (compat.sessionAffinityFormat === "openai") headers.session_id = sessionId;
			headers["x-client-request-id"] = sessionId;
		}
	}
	if (sessionId && getProviderCapabilities(model.provider).grokConversationHeader)
		headers["x-grok-conv-id"] = sessionId;
	return providerHeadersToRecord(headers, optionsHeaders) ?? {};
}
