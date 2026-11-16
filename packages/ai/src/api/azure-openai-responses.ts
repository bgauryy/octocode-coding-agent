import { streamSdk } from "./ai-sdk/stream.ts";
import { responsesMapping } from "./ai-sdk/responses-map.ts";
import type { Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import { hasProviderHeader, providerHeadersToRecord } from "../utils/headers.ts";
import { resolveTranscript } from "../utils/transcript.ts";
import type { AzureEndpointOptions } from "./azure-openai-config.ts";
import type { OpenAIResponsesOptions } from "./openai-responses/types.ts";
import { buildBaseOptions, requestedReasoningEffort } from "./simple-options.ts";

export interface AzureOpenAIResponsesOptions extends AzureEndpointOptions {
	azureADTokenProvider?: () => Promise<string>;
	reasoningEffort?: OpenAIResponsesOptions["reasoningEffort"];
	toolChoice?: OpenAIResponsesOptions["toolChoice"];
	reasoningSummary?: OpenAIResponsesOptions["reasoningSummary"];
}

export const stream: StreamFunction<"azure-openai-responses", AzureOpenAIResponsesOptions> = (
	model: Model<"azure-openai-responses">,
	context: TranscriptContext,
	options?: AzureOpenAIResponsesOptions,
) => {
	const normalized = resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages);
	const headers = providerHeadersToRecord(model.headers, options?.headers);
	const authorization = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
	const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1];
	const tokenProvider = options?.azureADTokenProvider ?? (!options?.apiKey && bearer ? async () => bearer : undefined);
	const sdkOptions = {
		...options,
		...(tokenProvider ? { headers: { ...options?.headers, "api-key": null } } : {}),
		azureADTokenProvider: tokenProvider,
	};
	return streamSdk(model, normalized, sdkOptions, responsesMapping(model, sdkOptions, normalized));
};

export const streamSimple: StreamFunction<"azure-openai-responses", SimpleStreamOptions> = (
	model: Model<"azure-openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => {
	const apiKey = options?.apiKey;
	if (!apiKey && !hasProviderHeader(options?.headers, "authorization")) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}
	return stream(model, context, {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
		reasoningEffort: requestedReasoningEffort(model, options),
	});
};
