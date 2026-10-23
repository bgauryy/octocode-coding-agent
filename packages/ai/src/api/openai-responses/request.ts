import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type {
	CacheRetention,
	Model,
	OpenAIResponsesCompat,
	ProviderEnv,
	ProviderHeaders,
	TranscriptContext,
	Usage,
} from "../../types.ts";
import { resolveCacheRetention, resolveInstructionCacheRetention } from "../../utils/cache-policy.ts";
import { providerHeadersToRecord } from "../../utils/headers.ts";
import { getPiUserAgent } from "../../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { resolveTranscriptTools } from "../../utils/transcript.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "../github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "../openai-prompt-cache.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	getResponsesToolSupport,
} from "../openai-responses-shared.ts";
import { resolveSamplingParams } from "../simple-options.ts";
import { getCompat, isChatGPTSignIn } from "./compat.ts";
import type { OpenAIResponsesOptions, ResponsesRequest } from "./types.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// OpenAI Responses rejects max_output_tokens below 16.
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
// Fixed reasoning.effort while configuration_update items carry the thinking level.
const CONFIGURATION_UPDATE_REQUEST_EFFORT = "medium";

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode
		? "24h"
		: undefined;
}

function getPromptCacheOptions(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): ResponsesRequest["prompt_cache_options"] {
	if (!compat.supportsExplicitPromptCacheMode) return undefined;
	if (cacheRetention === "none") return { mode: "explicit" };
	if (cacheRetention === "long" && compat.supportsLongCacheRetention) return { ttl: "30m" };
	return undefined;
}

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
	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	const omitUnsupportedFields = isChatGPTSignIn(model, options?.apiKey);
	const instructionRetention = resolveInstructionCacheRetention(options);
	const instructionCacheTtl =
		!omitUnsupportedFields &&
		compat.supportsExplicitPromptCacheMode &&
		instructionRetention !== undefined &&
		instructionRetention !== "none"
			? instructionRetention === "long" && compat.supportsLongCacheRetention
				? "12h"
				: "30m"
			: undefined;
	const transcriptTools = resolveTranscriptTools(context.messages, getResponsesToolSupport(compat));
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		instructionCacheTtl,
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
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: omitUnsupportedFields ? undefined : getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: omitUnsupportedFields ? undefined : getPromptCacheOptions(compat, cacheRetention),
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

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
		case "fast":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

export function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
