import { GoogleGenAI } from "@google/genai";
import type { Model, ProviderHeaders, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { getUserAgent } from "../utils/user-agent.ts";
import { baseUrlIncludesApiVersion } from "./google-shared/api-version.ts";
import { buildGoogleParams, type GoogleBaseOptions, resolveGoogleSimpleThinking } from "./google-shared/params.ts";
import { streamGoogle } from "./google-shared/stream.ts";
import { buildBaseOptions } from "./simple-options.ts";

export type GoogleOptions = GoogleBaseOptions;

export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: GoogleOptions,
): AssistantMessageEventStream =>
	streamGoogle(model, context, options, {
		name: "Google Generative AI",
		streamName: "Google",
		prepare: (normalized) => {
			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
			return {
				client: createClient(model, apiKey, options?.headers),
				params: buildGoogleParams(model, normalized, options),
			};
		},
	});

export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	return stream(model, context, {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
		thinking: resolveGoogleSimpleThinking(model, options),
	} satisfies GoogleOptions);
};

const GOOGLE_API_VERSION = "v1beta";

function createClient(
	model: Model<"google-generative-ai">,
	apiKey?: string,
	optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
	// Pin the version the SDK used by default so an SDK upgrade cannot move requests to another API version.
	const httpOptions: { baseUrl?: string; apiVersion?: string; headers?: Record<string, string> } = {
		apiVersion: GOOGLE_API_VERSION,
	};
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		if (baseUrlIncludesApiVersion(model.baseUrl)) {
			httpOptions.apiVersion = "";
		}
	}
	const headers = providerHeadersToRecord({ "User-Agent": getUserAgent(), ...model.headers, ...optionsHeaders });
	if (headers) {
		httpOptions.headers = headers;
	}

	return new GoogleGenAI({
		apiKey,
		httpOptions,
	});
}
