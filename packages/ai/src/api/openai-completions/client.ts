import type { Model, ProviderEnv, ProviderHeaders } from "../../types.ts";
import { providerHeadersToRecord } from "../../utils/headers.ts";
import { getUserAgent } from "../../utils/user-agent.ts";
import type { TranscriptContext } from "../../utils/transcript.ts";
import { getProviderCapabilities } from "../../utils/provider-capabilities.ts";
import { copilotDynamicHeadersFor } from "../github-copilot-headers.ts";
import { openAIEnvironmentHeaders } from "../openai-environment-headers.ts";
import { getCompat } from "./compat.ts";
import type { ResolvedOpenAICompletionsCompat } from "./types.ts";

export function createClient(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
	env?: ProviderEnv,
) {
	const headers: ProviderHeaders = { "User-Agent": getUserAgent(), ...model.headers };
	Object.assign(headers, copilotDynamicHeadersFor(model.provider, context.messages));

	if (sessionId && compat.sendSessionAffinityHeaders) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
			headers["x-session-affinity"] = sessionId;
		}
	}

	if (sessionId && getProviderCapabilities(model.provider).grokConversationHeader) {
		headers["x-grok-conv-id"] = sessionId;
	}

	const url = new URL(model.baseUrl);
	url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
	return {
		url: url.href,
		fetch,
		headers: providerHeadersToRecord(
			{ Authorization: `Bearer ${apiKey}` },
			openAIEnvironmentHeaders(env),
			headers,
			optionsHeaders,
		),
	};
}
