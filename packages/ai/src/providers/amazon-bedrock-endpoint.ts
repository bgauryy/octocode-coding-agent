import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { bedrockConverseStreamApi } from "../api/bedrock-converse-stream.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { endpointFromAnswers } from "../auth/endpoint.ts";
import type { ApiKeyEndpoint, ApiKeyHostOption } from "../auth/types.ts";
import type { Api, Model, ProviderStreams, SimpleStreamOptions, StreamOptions } from "../types.ts";

/** The request APIs a custom Amazon Bedrock host can speak. */
const BEDROCK_ENDPOINT_APIS = ["bedrock-converse-stream", "openai-completions", "anthropic-messages"] as const;
export type BedrockEndpointApi = (typeof BEDROCK_ENDPOINT_APIS)[number];

/** Request option carrying the API a user picked for a host whose name does not tell (see `endpointEnv`). */
const ENDPOINT_API_ENV = "OCTOCODE_ENDPOINT_API";

/**
 * The family of a Bedrock host by name: `bedrock-runtime.*` speaks the Converse stream, `bedrock-mantle.*` the
 * OpenAI-compatible and Anthropic Messages APIs (docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html).
 */
export function bedrockHostFamily(baseUrl: string): "runtime" | "mantle" | "unknown" {
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname;
	} catch {
		return "unknown";
	}
	if (/^bedrock-runtime(?:-fips)?\./.test(hostname)) return "runtime";
	if (/^bedrock-mantle(?:-fips)?\./.test(hostname)) return "mantle";
	return "unknown";
}

/**
 * The endpoint a Bedrock key is saved with, from the host, region and API answers. The host name tells the API of a
 * Bedrock host; any other host must say which one it speaks. bedrock-mantle takes only an Amazon Bedrock API key
 * (bearer token), never AWS credentials. Throws a message that never carries the URL.
 */
export function bedrockEndpoint(
	answers: { host: string; region?: string; api?: string },
	method: string,
): ApiKeyEndpoint | undefined {
	if (!answers.host.trim()) return undefined;
	const checked = endpointFromAnswers(answers.host, "");
	const family = bedrockHostFamily(checked?.baseUrl ?? "");
	if (family === "mantle" && method !== "bearer-token") {
		throw new Error("A bedrock-mantle host needs an Amazon Bedrock API key (bearer token), not AWS credentials.");
	}
	if (family !== "unknown") return endpointFromAnswers(answers.host, answers.region ?? "");
	if (!isEndpointApi(answers.api)) {
		throw new Error(`Say which API this host serves: ${BEDROCK_ENDPOINT_APIS.join(", ")}. Its name does not tell.`);
	}
	return endpointFromAnswers(answers.host, answers.region ?? "", answers.api);
}

/** The APIs an unknown Bedrock host may speak, as the login asks them. */
export const BEDROCK_API_CHOICES = [
	{ id: BEDROCK_ENDPOINT_APIS[0], label: "Bedrock Converse" },
	{ id: BEDROCK_ENDPOINT_APIS[1], label: "OpenAI-compatible Chat Completions" },
	{ id: BEDROCK_ENDPOINT_APIS[2], label: "Anthropic Messages" },
] as const;

/** The host option of Amazon Bedrock (a Bedrock API key's host); the web page signs in with a bearer token. */
export const BEDROCK_HOST: ApiKeyHostOption = {
	example: "bedrock-runtime.eu-central-1.amazonaws.com",
	region: true,
	apis: BEDROCK_API_CHOICES,
	endpoint: (answers) => bedrockEndpoint(answers, "bearer-token"),
};

const isEndpointApi = (value: string | undefined): value is BedrockEndpointApi =>
	BEDROCK_ENDPOINT_APIS.includes(value as BedrockEndpointApi);

/**
 * On bedrock-mantle the base path depends on the model family: OpenAI models use `/openai/v1`, every other model
 * `/v1`, and Claude models take the Anthropic Messages API under `/anthropic` (the endpoints, Chat Completions and
 * Messages pages of the Bedrock user guide, and the OpenAI model cards: "On bedrock-mantle, both APIs use the
 * /openai/v1 base path. Do not use /v1").
 */
export function mantleRoute(modelId: string, baseUrl: string): { api: BedrockEndpointApi; baseUrl: string } {
	const origin = new URL(baseUrl).origin;
	if (modelId.startsWith("anthropic.")) return { api: "anthropic-messages", baseUrl: `${origin}/anthropic` };
	if (modelId.startsWith("openai.")) return { api: "openai-completions", baseUrl: `${origin}/openai/v1` };
	return { api: "openai-completions", baseUrl: `${origin}/v1` };
}

/** The API and base URL a request to `model` uses: the model's own Converse stream unless its host says otherwise. */
export function bedrockRoute(
	model: Model<Api>,
	env: Record<string, string> | undefined,
): { api: BedrockEndpointApi; baseUrl: string } {
	const family = bedrockHostFamily(model.baseUrl);
	if (family === "mantle") return mantleRoute(model.id, model.baseUrl);
	if (family === "runtime") return { api: "bedrock-converse-stream", baseUrl: model.baseUrl };
	const picked = env?.[ENDPOINT_API_ENV];
	// A host whose name does not tell speaks the API the user picked; without a pick it is the default, Converse.
	return { api: isEndpointApi(picked) ? picked : "bedrock-converse-stream", baseUrl: model.baseUrl };
}

/** Anthropic's Messages API on bedrock-mantle takes the Bedrock API key as a bearer token. */
function withMantleHeaders<TOptions extends StreamOptions>(
	api: BedrockEndpointApi,
	options: TOptions | undefined,
): TOptions | undefined {
	if (api !== "anthropic-messages" || !options?.apiKey) return options;
	return { ...options, headers: { Authorization: `Bearer ${options.apiKey}`, ...options.headers } };
}

/**
 * Amazon Bedrock streams: the Converse stream, or, for a custom host (a Bedrock API key's bedrock-mantle host), the
 * API that host serves. A model keeps its catalog entry; only the request is redirected.
 */
export function bedrockStreams(): ProviderStreams {
	const implementations: Record<BedrockEndpointApi, ProviderStreams> = {
		"bedrock-converse-stream": bedrockConverseStreamApi(),
		"openai-completions": openAICompletionsApi(),
		"anthropic-messages": anthropicMessagesApi(),
	};
	const redirect = <TOptions extends StreamOptions>(model: Model<Api>, options: TOptions | undefined) => {
		const route = bedrockRoute(model, options?.env);
		const target =
			route.api === "bedrock-converse-stream" ? model : { ...model, api: route.api, baseUrl: route.baseUrl };
		return {
			streams: implementations[route.api],
			model: target,
			options: withMantleHeaders(route.api, options),
		};
	};
	return {
		stream: (model, context, options) => {
			const routed = redirect(model, options);
			return routed.streams.stream(routed.model, context, routed.options);
		},
		streamSimple: (model, context, options?: SimpleStreamOptions) => {
			const routed = redirect(model, options);
			return routed.streams.streamSimple(routed.model, context, routed.options);
		},
	};
}
