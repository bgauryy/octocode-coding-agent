import OpenAI from "openai";
import type { Model, ProviderHeaders } from "../../types.ts";
import { getPiUserAgent } from "../../utils/pi-user-agent.ts";
import type { TranscriptContext } from "../../utils/transcript.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "../github-copilot-headers.ts";
import { getCompat } from "./compat.ts";
import type { ResolvedOpenAICompletionsCompat } from "./types.ts";

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

export function getClientApiKey(
	provider: string,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

export function createClient(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
) {
	const headers: ProviderHeaders = { "User-Agent": getPiUserAgent(), ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

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

	if (sessionId && model.provider === "xai") {
		headers["x-grok-conv-id"] = sessionId;
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}
