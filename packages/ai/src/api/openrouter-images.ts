import { createStatusCodeErrorResponseHandler, postToApi } from "@ai-sdk/provider-utils";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type {
	AssistantImages,
	ImageApi,
	ImageContent,
	ImageModel,
	ImagesContext,
	ImagesFunction,
	ImagesOptions,
	TextContent,
} from "../types.ts";
import { calculateCost } from "../models/model-helpers.ts";
import { createUsage } from "../utils/assistant-message.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { openAIEnvironmentHeaders } from "./openai-environment-headers.ts";

interface OpenRouterGeneratedImage {
	image_url?: string | { url?: string };
}

interface OpenRouterImageGenerationResponse {
	id: string;
	choices: Array<{ message: { content?: string | null; images?: OpenRouterGeneratedImage[] } }>;
	usage?: Parameters<typeof parseUsage>[0];
}

/** Image generation over OpenRouter's chat completions endpoint. */
export const generateImages: ImagesFunction = async (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		const apiKey = options?.apiKey;
		if (!apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		let params = buildParams(model, context);
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) {
			params = nextParams as typeof params;
		}
		const headers = providerHeadersToRecord(
			{ authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			openAIEnvironmentHeaders(options?.env),
			model.headers,
			options?.headers,
		);
		const { data: response, response: rawResponse } = await retryProviderRequest(
			async () => {
				const timeout = options?.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
				const signal =
					timeout && options?.signal ? AbortSignal.any([timeout, options.signal]) : (options?.signal ?? timeout);
				signal?.throwIfAborted();
				const requestFetch = options?.fetch ?? globalThis.fetch;
				const url = new URL(model.baseUrl);
				url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
				const result = await raceWithAbortSignal(
					postToApi({
						url: url.href,
						headers,
						body: { content: JSON.stringify(params), values: params },
						abortSignal: signal,
						fetch: async (input, init) => {
							const response = await requestFetch(input, init);
							if (signal?.aborted) {
								void response.body?.cancel().catch(() => {});
								signal.throwIfAborted();
							}
							return signal && response.body
								? new Response(response.body.pipeThrough(new TransformStream(), { signal }), response)
								: response;
						},
						failedResponseHandler: createStatusCodeErrorResponseHandler(),
						successfulResponseHandler: async ({ response }) => {
							const value: unknown = await response.json();
							if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.choices)) {
								throw new Error("OpenRouter returned an invalid image response");
							}
							for (const choice of value.choices) {
								if (!isRecord(choice) || !isRecord(choice.message))
									throw new Error("OpenRouter returned an invalid image choice");
							}
							return { value: { data: value as unknown as OpenRouterImageGenerationResponse, response } };
						},
					}),
					signal,
				);
				return result.value;
			},
			{
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
			},
		);
		await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);

		const imageResponse = response;
		output.responseId = imageResponse.id;
		if (imageResponse.usage) {
			output.usage = parseUsage(imageResponse.usage, model);
		}

		const choice = imageResponse.choices[0];
		if (choice) {
			const content = choice.message.content;
			if (typeof content === "string" && content.length > 0) {
				output.output.push({ type: "text", text: content } satisfies TextContent);
			}

			for (const image of choice.message.images ?? []) {
				const imageUrl = typeof image.image_url === "string" ? image.image_url : image.image_url?.url;
				if (!imageUrl?.startsWith("data:")) continue;
				const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
				if (!matches) continue;
				output.output.push({
					type: "image",
					mimeType: matches[1],
					data: matches[2],
				} satisfies ImageContent);
			}
		}

		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	}
};

type ImageInputPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
interface OpenRouterImagesCreateParams {
	model: string;
	messages: Array<{ role: "user"; content: ImageInputPart[] }>;
	stream: false;
	modalities: Array<"image" | "text">;
}

function buildParams(model: ImageModel<ImageApi>, context: ImagesContext): OpenRouterImagesCreateParams {
	const content: ImageInputPart[] = context.input.map((item): ImageInputPart => {
		if (item.type === "text") {
			return {
				type: "text",
				text: sanitizeSurrogates(item.text),
			} satisfies ImageInputPart;
		}
		return {
			type: "image_url",
			image_url: {
				url: `data:${item.mimeType};base64,${item.data}`,
			},
		} satisfies ImageInputPart;
	});

	return {
		model: model.id,
		messages: [
			{
				role: "user" as const,
				content,
			},
		],
		stream: false,
		modalities: model.output.includes("text") ? ["image", "text"] : ["image"],
	};
}

function parseUsage(
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	},
	model: ImageModel<ImageApi>,
) {
	const promptTokens = rawUsage.prompt_tokens ?? 0;
	// cached_tokens counts reads only; writes are a separate count (same contract as openai-completions/usage.ts).
	const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens ?? 0;
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const output = rawUsage.completion_tokens ?? 0;
	const usage = createUsage({ input, output, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens });
	calculateCost(model, usage);
	return usage;
}
