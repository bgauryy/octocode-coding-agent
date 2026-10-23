import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { Model, ProviderHeaders, TranscriptContext, Usage } from "../../types.ts";
import { getPiUserAgent } from "../../utils/pi-user-agent.ts";
import { getSystemMessageText } from "../../utils/text.ts";
import { getDeclaredTools, getInitialSystemMessage, resolveTranscriptTools } from "../../utils/transcript.ts";
import { createGrammarToolInputProperties } from "../constrained-sampling.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	getResponsesToolSupport,
} from "../openai-responses-shared.ts";
import {
	CODEX_TOOL_CALL_PROVIDERS,
	DEFAULT_CODEX_BASE_URL,
	JWT_CLAIM_PATH,
	type OpenAICodexResponsesOptions,
	type RequestBody,
} from "./types.ts";

// ============================================================================
// Request Building
// ============================================================================

export function buildRequestBody(
	model: Model<"openai-codex-responses">,
	context: TranscriptContext,
	options: OpenAICodexResponsesOptions | undefined,
	cacheSessionId: string | undefined,
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		model.compat?.supportsOpenAIGrammarTools ?? false,
	),
): RequestBody {
	const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
	const supportsAdditionalTools = model.compat?.supportsAdditionalTools ?? false;
	const supportsToolSearch = model.compat?.supportsToolSearch ?? false;
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		getResponsesToolSupport({
			supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
			supportsAdditionalTools,
			supportsToolSearch,
		}),
	);
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		supportsAdditionalTools,
		supportsToolSearch,
		toolOptions: { strict: null, supportsStrictMode, supportsOpenAIGrammarTools },
	});

	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const instructions = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const body: RequestBody = {
		model: model.id,
		store: false,
		stream: true,
		instructions: instructions || "You are a helpful assistant.",
		input: messages,
		text: { verbosity: options?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: cacheSessionId,
		tool_choice: options?.toolChoice ?? "auto",
		parallel_tool_calls: true,
	};

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	if (options?.serviceTier !== undefined) {
		body.service_tier = options.serviceTier;
	}

	if (transcriptTools.requestTools.length > 0) {
		body.tools = convertResponsesTools(transcriptTools.requestTools, {
			strict: null,
			supportsStrictMode,
			supportsOpenAIGrammarTools,
		});
	}

	if (options?.reasoningEffort !== undefined) {
		const effort =
			options.reasoningEffort === "none"
				? model.thinkingLevelMap?.off === undefined
					? "none"
					: model.thinkingLevelMap.off
				: (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
		if (effort !== null) {
			body.reasoning = {
				effort,
				summary: options.reasoningSummary ?? "auto",
			};
		}
	} else if (model.reasoning && model.thinkingLevelMap?.off !== null) {
		body.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
	}

	return body;
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-codex-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

export function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-codex-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

export function resolveCodexServiceTier(
	responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): ResponseCreateParamsStreaming["service_tier"] | undefined {
	if (responseServiceTier === "default" && (requestServiceTier === "flex" || requestServiceTier === "priority")) {
		return requestServiceTier;
	}
	return responseServiceTier ?? requestServiceTier;
}

export function resolveCodexUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

export function resolveCodexWebSocketUrl(baseUrl?: string): string {
	const url = new URL(resolveCodexUrl(baseUrl));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";

// ============================================================================
// Auth & Headers
// ============================================================================

export function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(atob(parts[1]));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

function buildBaseCodexHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
): Headers {
	// Defaults first so model and caller headers can override them, matching the other providers.
	const headers = new Headers({ originator: "pi", "User-Agent": getPiUserAgent() });
	for (const [key, value] of Object.entries(initHeaders || {})) {
		headers.set(key, value);
	}
	for (const [key, value] of Object.entries(additionalHeaders || {})) {
		if (value === null) {
			headers.delete(key);
		} else {
			headers.set(key, value);
		}
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	return headers;
}

export function buildSSEHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	sessionId?: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");

	if (sessionId) {
		headers.set("session-id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}

	return headers;
}

export function buildWebSocketHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	requestId: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	headers.set("x-client-request-id", requestId);
	headers.set("session-id", requestId);
	return headers;
}
