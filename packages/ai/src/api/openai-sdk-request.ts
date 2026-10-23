import type { Api, Model, StreamOptions } from "../types.ts";
import { headersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";

interface SdkRequestOptions {
	signal?: AbortSignal;
	timeout?: number;
	maxRetries: number;
}

/**
 * Sends a streaming request through an OpenAI SDK client with the adapter's retry policy
 * and reports the HTTP response to `onResponse`. If that callback throws, the unread
 * response is released before the error propagates.
 */
export async function requestOpenAISdkStream<TStream extends { controller: AbortController }>(
	model: Model<Api>,
	options: StreamOptions | undefined,
	create: (requestOptions: SdkRequestOptions) => { withResponse(): Promise<{ data: TStream; response: Response }> },
): Promise<TStream> {
	const requestOptions: SdkRequestOptions = {
		...(options?.signal ? { signal: options.signal } : {}),
		...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
		maxRetries: 0,
	};
	const { data: openaiStream, response } = await retryProviderRequest(() => create(requestOptions).withResponse(), {
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		signal: options?.signal,
	});
	try {
		await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	} catch (error) {
		// Iteration has not started, so the SDK iterator cannot release this response yet.
		openaiStream.controller.abort();
		await response.body?.cancel().catch(() => {});
		throw error;
	}
	return openaiStream;
}
