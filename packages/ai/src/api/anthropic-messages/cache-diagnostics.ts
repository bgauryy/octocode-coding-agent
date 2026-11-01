import type {
	BetaCacheMissReason,
	BetaDiagnostics,
	BetaDiagnosticsParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { Model, ProviderEnv } from "../../types.ts";
import type { AssistantMessageDiagnostic } from "../../utils/diagnostics.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { TranscriptContext } from "../../utils/transcript.ts";

/** Set to `on` to ask the Anthropic API why a request could not reuse the previous request's cached prefix. */
const CACHE_DIAGNOSTICS_ENV = "OCTOCODE_CACHE_DIAGNOSTICS";

/** Assistant-message diagnostic type that carries the API's miss reason in `details.reason`. */
const CACHE_MISS_DIAGNOSTIC_TYPE = "cache_miss";

/**
 * Cache diagnostics exist on the Claude API only (not Bedrock or Vertex), so the request field goes to
 * api.anthropic.com alone; a gateway or proxy may reject an unknown body field.
 */
function isDirectAnthropic(model: Model<"anthropic-messages">): boolean {
	if (model.provider !== "anthropic") return false;
	try {
		return new URL(model.baseUrl).origin === "https://api.anthropic.com";
	} catch {
		return false;
	}
}

function enabled(env?: ProviderEnv): boolean {
	const value = getProviderEnvValue(CACHE_DIAGNOSTICS_ENV, env)?.toLowerCase();
	return value === "on" || value === "1" || value === "true";
}

/**
 * The request's `diagnostics` field, or undefined when diagnostics are off or unsupported. The field names the
 * previous response of this conversation (the API stores a fingerprint of that request and compares it with this
 * one); the first request opts in with `null`. Only the API's own message ids (`msg_...`) can be compared.
 */
export function buildCacheDiagnosticsParam(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	env?: ProviderEnv,
): BetaDiagnosticsParam | undefined {
	if (!enabled(env) || !isDirectAnthropic(model)) return undefined;
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "assistant" || message.api !== model.api || message.provider !== model.provider) continue;
		if (message.responseId?.startsWith("msg_")) return { previous_message_id: message.responseId };
	}
	return { previous_message_id: null };
}

function describe(reason: BetaCacheMissReason): { reason: string; missedInputTokens?: number } {
	return "cache_missed_input_tokens" in reason
		? { reason: reason.type, missedInputTokens: reason.cache_missed_input_tokens }
		: { reason: reason.type };
}

/**
 * The diagnostic to record on the reply, or undefined when the API found no divergence, the comparison was still
 * pending, or no comparison was possible (`previous_message_not_found`, `unavailable` say nothing about the request).
 */
export function cacheMissDiagnostic(
	diagnostics: BetaDiagnostics | null | undefined,
	timestamp = Date.now(),
): AssistantMessageDiagnostic | undefined {
	const reason = diagnostics?.cache_miss_reason;
	if (!reason || reason.type === "previous_message_not_found" || reason.type === "unavailable") return undefined;
	return { type: CACHE_MISS_DIAGNOSTIC_TYPE, timestamp, details: describe(reason) };
}
