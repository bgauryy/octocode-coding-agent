import type { LanguageModel } from "ai";
import type { Api, Model, StreamOptions } from "../../types.ts";
import { resolveAzureConfig, resolveDeploymentName, type AzureEndpointOptions } from "../azure-openai-config.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { baseUrlIncludesApiVersion } from "./google-api-version.ts";
import { refuseClaudeSubscriptionToken } from "../anthropic-messages/token.ts";

export type SdkOptions = StreamOptions &
	AzureEndpointOptions & {
		azureADTokenProvider?: () => Promise<string>;
		project?: string;
		location?: string;
	};

function googleSdkBaseURL(baseUrl: string, version = "v1beta"): string | undefined {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (!trimmed) return undefined;
	return baseUrlIncludesApiVersion(trimmed) ? trimmed : `${trimmed}/${version}`;
}

/**
 * Builds the SDK model for one request. Each provider's SDK package loads on first use of that provider,
 * so a session that talks to one provider never loads the others.
 */
export async function sdkModel(
	model: Model<Api>,
	options: SdkOptions,
	fetch: typeof globalThis.fetch,
): Promise<LanguageModel> {
	const apiKey = options.apiKey;
	const settings = { apiKey, fetch };
	switch (model.api) {
		case "anthropic-messages": {
			refuseClaudeSubscriptionToken(apiKey, { ...model.headers, ...options.headers });
			const { anthropicSdkModel } = await import("./anthropic-provider.ts");
			return anthropicSdkModel(model as Model<"anthropic-messages">, options, fetch);
		}
		case "mistral-conversations": {
			const { mistralSdkModel } = await import("./mistral-provider.ts");
			return mistralSdkModel(model as Model<"mistral-conversations">, options, fetch);
		}
		case "openai-completions": {
			const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
			return createOpenAICompatible({
				...settings,
				name: "octocode",
				baseURL: model.baseUrl,
				includeUsage: true,
				transformRequestBody: (body) => {
					const { max_tokens: maxTokens, ...rest } = body;
					const messages = body.messages as { role: string; tool_calls?: unknown[] }[];
					const hasToolHistory = messages.some((message) => message.role === "tool" || message.tool_calls?.length);
					return {
						...rest,
						...(hasToolHistory && !body.tools ? { tools: [] } : {}),
						...(maxTokens !== undefined ? { max_completion_tokens: maxTokens } : {}),
					};
				},
			}).chatModel(model.id);
		}
		case "openai-responses": {
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
			const { createOpenAI } = await import("@ai-sdk/openai");
			const provider = createOpenAI({ ...settings, baseURL: model.baseUrl });
			return provider.responses(model.id);
		}
		case "azure-openai-responses": {
			if (!apiKey && !options.azureADTokenProvider) throw new Error(`No API key for provider: ${model.provider}`);
			const config = resolveAzureConfig(model, options);
			const { createAzure } = await import("@ai-sdk/azure");
			const base = new URL(config.baseUrl);
			const query = new URLSearchParams(base.search);
			base.search = "";
			return createAzure({
				...settings,
				apiKey: options.azureADTokenProvider ? "" : apiKey,
				baseURL: base.href.replace(/\/$/, ""),
				fetch: (input, init) => {
					const url = new URL(input instanceof Request ? input.url : input.toString());
					for (const [key, value] of query) url.searchParams.set(key, value);
					url.searchParams.set("api-version", config.apiVersion);
					return fetch(url.href, init);
				},
				apiVersion: config.apiVersion,
				tokenProvider: options.azureADTokenProvider,
				useDeploymentBasedUrls: false,
			}).responses(resolveDeploymentName(model, options));
		}
		case "google-generative-ai": {
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
			const base = model.baseUrl.trim() ? new URL(model.baseUrl.trim()) : undefined;
			const query = new URLSearchParams(base?.search);
			if (base) base.search = "";
			const { createGoogle } = await import("@ai-sdk/google");
			return createGoogle({
				...settings,
				baseURL: googleSdkBaseURL(base?.href ?? ""),
				fetch: (input, init) => {
					const url = new URL(input instanceof Request ? input.url : input.toString());
					for (const [key, value] of query) if (!url.searchParams.has(key)) url.searchParams.append(key, value);
					return fetch(url.href, init);
				},
			})(model.id);
		}
		case "google-vertex": {
			const key = apiKey?.trim();
			const vertexKey = key && key !== "gcp-vertex-credentials" && !/^<[^>]+>$/.test(key) ? key : undefined;
			const project =
				options.project ||
				getProviderEnvValue("GOOGLE_CLOUD_PROJECT", options.env) ||
				getProviderEnvValue("GCLOUD_PROJECT", options.env);
			const location = options.location || getProviderEnvValue("GOOGLE_CLOUD_LOCATION", options.env);
			if (!vertexKey && !project)
				throw new Error(
					"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
				);
			if (!vertexKey && !location)
				throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
			if (location && !/^[a-z0-9-]+$/.test(location))
				throw new Error(
					"Vertex AI location must be a region id such as us-central1 or global. Check GOOGLE_CLOUD_LOCATION.",
				);

			const custom =
				model.baseUrl && !model.baseUrl.includes("{location}") ? googleSdkBaseURL(model.baseUrl, "v1") : undefined;
			const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
			const baseURL =
				custom ??
				(vertexKey
					? "https://aiplatform.googleapis.com/v1/publishers/google"
					: `https://${host}/v1/projects/${encodeURIComponent(project ?? "")}/locations/${location}/publishers/google`);
			// An API key needs no Google auth library, so it uses the browser-safe entry; credentials are Node only.
			if (vertexKey) {
				const { createGoogleVertex } = await import("@ai-sdk/google-vertex/edge");
				return createGoogleVertex({ fetch, apiKey: vertexKey, project, location, baseURL })(model.id);
			}
			const { loadVertexNodeModule } = await import("./vertex-node.lazy.ts");
			return (await loadVertexNodeModule()).vertexCredentialsModel(
				{ fetch, project, location, baseURL },
				model.id,
				getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", options.env),
				getProviderEnvValue("GOOGLE_CLOUD_QUOTA_PROJECT", options.env),
			);
		}
		default:
			throw new Error(`Unsupported AI SDK API: ${model.api}`);
	}
}
