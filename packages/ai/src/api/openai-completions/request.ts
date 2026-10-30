import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import type { Model } from "../../types.ts";
import { headersToRecord, providerHeadersToRecord } from "../../utils/headers.ts";
import { requestJsonEventStream } from "../../utils/json-event-stream.ts";
import { retryProviderRequest } from "../../utils/provider-retry.ts";
import type { createClient } from "./client.ts";
import type { OpenAICompletionsOptions } from "./types.ts";

/** Vercel owns HTTP and SSE framing; native extensions stay in the existing chunk projector. */
export async function requestCompletionsStream(
	model: Model<"openai-completions">,
	client: ReturnType<typeof createClient>,
	params: unknown,
	options?: OpenAICompletionsOptions,
): Promise<AsyncGenerator<ChatCompletionChunk>> {
	const request = await retryProviderRequest(
		() =>
			requestJsonEventStream(
				new URL(client.url),
				params,
				providerHeadersToRecord({ "Content-Type": "application/json" }, client.headers) ?? {},
				{ ...options, fetch: client.fetch, timeoutScope: "headers" },
			),
		options,
	);
	try {
		// Response hooks are consumers, so their failures must not trigger another HTTP request.
		await options?.onResponse?.(
			{ status: request.response.status, headers: headersToRecord(request.response.headers) },
			model,
		);
		return iterateChunks(request);
	} catch (error) {
		request.dispose();
		throw error;
	}
}

async function* iterateChunks(
	request: Awaited<ReturnType<typeof requestJsonEventStream>>,
): AsyncGenerator<ChatCompletionChunk> {
	try {
		for await (const chunk of request.events) {
			if (chunk && typeof chunk === "object" && "error" in chunk && chunk.error !== undefined) {
				throw Object.assign(new Error(JSON.stringify(chunk)), { error: chunk.error });
			}
			yield chunk as ChatCompletionChunk;
		}
	} finally {
		request.dispose();
	}
}
