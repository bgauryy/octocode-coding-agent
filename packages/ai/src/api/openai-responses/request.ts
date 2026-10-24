import type { Model, OpenAIResponsesCompat, ProviderEnv, ProviderHeaders, TranscriptContext } from "../../types.ts";
import { providerHeadersToRecord } from "../../utils/headers.ts";
import { getPiUserAgent } from "../../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { resolveTranscriptTools } from "../../utils/transcript.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "../github-copilot-headers.ts";
import { resolveOpenAIResponsesCacheFields } from "../openai-prompt-cache.ts";
import { convertResponsesMessages, RESPONSES_TOOL_CALL_PROVIDERS } from "../openai-responses-shared/messages.ts";
export { applyServiceTierPricing } from "../openai-responses-shared/service-tier.ts";
import { convertResponsesTools, getResponsesToolSupport } from "../openai-responses-shared/tools.ts";
import { resolveSamplingParams } from "../simple-options.ts";
import { getCompat, isChatGPTSignIn } from "./compat.ts";
import type { OpenAIResponsesOptions, ResponsesRequest } from "./types.ts";

// OpenAI Responses rejects max_output_tokens below 16.
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
// Fixed reasoning.effort while configuration_update items carry the thinking level.
const CONFIGURATION_UPDATE_REQUEST_EFFORT = "medium";

export function createRequestHeaders(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	sessionId?: string,
	env?: ProviderEnv,
) {
	const compat = getCompat(model);
	const environmentHeaders: ProviderHeaders = {};
	const organization = getProviderEnvValue("OPENAI_ORG_ID", env);
	const project = getProviderEnvValue("OPENAI_PROJECT_ID", env);
	if (organization) environmentHeaders["OpenAI-Organization"] = organization;
	if (project) environmentHeaders["OpenAI-Project"] = project;
	for (const line of getProviderEnvValue("OPENAI_CUSTOM_HEADERS", env)?.split("\n") ?? []) {
		const colon = line.indexOf(":");
		if (colon >= 0) environmentHeaders[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
	}
	const headers: ProviderHeaders =
		providerHeadersToRecord(
			{
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				Authorization: `Bearer ${apiKey}`,
			},
			environmentHeaders,
			{ "User-Agent": getPiUserAgent() },
			model.headers,
		) ?? {};
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
		}
	}

	// xAI recommends this header for cache routing (the completions client sends it too).
	if (sessionId && model.provider === "xai") headers["x-grok-conv-id"] = sessionId;

	return providerHeadersToRecord(headers, optionsHeaders) ?? {};
}

export function buildParams(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat>,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	configurationUpdateEffort: string | undefined,
) {
	const omitUnsupportedFields = isChatGPTSignIn(model, options?.apiKey);
	const { instructionCacheTtl, ...cacheFields } = resolveOpenAIResponsesCacheFields(
		compat,
		options,
		omitUnsupportedFields,
	);
	const transcriptTools = resolveTranscriptTools(context.messages, getResponsesToolSupport(compat));
	const messages = convertResponsesMessages(model, context, RESPONSES_TOOL_CALL_PROVIDERS, {
		instructionCacheTtl,
		instructionCacheBoundary: options?.instructionCacheBoundary,
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
		supportsAdditionalTools: compat.supportsAdditionalTools,
		supportsToolSearch: compat.supportsToolSearch,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
		configurationUpdateEffort,
	});

	const params: ResponsesRequest = {
		model: model.id,
		input: messages,
		stream: true,
		...cacheFields,
		store: false,
	};

	if (options?.maxTokens && compat.supportsMaxOutputTokens && !omitUnsupportedFields) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined && !omitUnsupportedFields) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertResponsesTools(transcriptTools.requestTools, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
	}

	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	const reasoningEffort = options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : undefined);
	if (model.reasoning) {
		if (reasoningEffort) {
			const requestedEffort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: reasoningEffort;
			const effort = configurationUpdateEffort === undefined ? requestedEffort : CONFIGURATION_UPDATE_REQUEST_EFFORT;
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
		if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
	}

	// Last so model and request sampling parameters override named request fields.
	const samplingParams = resolveSamplingParams(model, reasoningEffort ?? "off", options?.samplingParams);
	if (samplingParams) {
		Object.assign(params, samplingParams);
	}

	return params;
}
