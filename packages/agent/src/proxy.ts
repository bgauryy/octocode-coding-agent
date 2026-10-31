/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */

import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { createAbortError } from "@octocodeai/octocode-ai/utils/abort";
import { createPendingAssistantMessage } from "@octocodeai/octocode-ai/utils/assistant-message";
import { failProxyStream, type ProxyAssistantMessageEvent, processProxyEvent } from "./proxy/events.ts";

export type { ProxyAssistantMessageEvent } from "./proxy/events.ts";

const ABORT_MESSAGE = "Request aborted by user";

type ProxySerializableStreamOptions = Pick<
	SimpleStreamOptions,
	| "temperature"
	| "samplingParams"
	| "maxTokens"
	| "reasoning"
	| "cacheRetention"
	| "instructionCacheRetention"
	| "instructionCacheBoundary"
	| "sessionId"
	| "headers"
	| "metadata"
	| "transport"
	| "thinkingBudgets"
	| "maxRetryDelayMs"
>;

export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
	/** Local abort signal for the proxy request */
	signal?: AbortSignal;
	/** Auth token for the proxy server */
	authToken: string;
	/** Proxy server URL (e.g., "https://genai.example.com") */
	proxyUrl: string;
}

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 * The server strips the partial field from delta events to reduce bandwidth.
 * We reconstruct the partial message client-side.
 *
 * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
function buildProxyRequestOptions(options: ProxyStreamOptions): ProxySerializableStreamOptions {
	return {
		temperature: options.temperature,
		samplingParams: options.samplingParams,
		maxTokens: options.maxTokens,
		reasoning: options.reasoning,
		cacheRetention: options.cacheRetention,
		instructionCacheRetention: options.instructionCacheRetention,
		instructionCacheBoundary: options.instructionCacheBoundary,
		sessionId: options.sessionId,
		headers: options.headers,
		metadata: options.metadata,
		transport: options.transport,
		thinkingBudgets: options.thinkingBudgets,
		maxRetryDelayMs: options.maxRetryDelayMs,
	};
}

export function streamProxy(
	model: Model<any>,
	context: TranscriptContext,
	options: ProxyStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		// Initialize the partial message that we'll build up from events
		const partial: AssistantMessage = createPendingAssistantMessage(model);

		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

		const abortHandler = () => {
			if (reader) {
				reader.cancel(ABORT_MESSAGE).catch(() => {});
			}
		};

		if (options.signal) {
			options.signal.addEventListener("abort", abortHandler);
		}

		try {
			const response = await fetch(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					context,
					options: buildProxyRequestOptions(options),
				}),
				signal: options.signal,
			});

			if (!response.ok) {
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				try {
					const errorData = (await response.json()) as { error?: string };
					if (errorData.error) {
						errorMessage = `Proxy error: ${errorData.error}`;
					}
				} catch {
					// Couldn't parse error response
				}
				throw new Error(errorMessage);
			}

			reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let sawTerminalEvent = false;

			const processLine = (line: string): void => {
				if (sawTerminalEvent || !line.startsWith("data: ")) return;
				const data = line.slice(6).trim();
				if (!data) return;
				const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
				const event = processProxyEvent(proxyEvent, partial);
				if (event) {
					if (event.type === "done" || event.type === "error") sawTerminalEvent = true;
					stream.push(event);
				}
			};

			while (!sawTerminalEvent) {
				const { done, value } = await reader.read();
				if (done) break;

				if (options.signal?.aborted) {
					throw createAbortError(ABORT_MESSAGE);
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					processLine(line);
				}
			}

			if (options.signal?.aborted) {
				throw createAbortError(ABORT_MESSAGE);
			}

			// The final event may not be newline-terminated; flush the decoder and
			// process whatever is left in the buffer.
			buffer += decoder.decode();
			if (buffer) {
				processLine(buffer);
			}

			if (!sawTerminalEvent) {
				// A clean EOF without a done/error event means the server dropped the
				// response mid-stream. Surface it as an error instead of leaving
				// consumers waiting on a result that never arrives.
				stream.push(
					failProxyStream(partial, "error", "Connection closed by proxy server before the response completed"),
				);
			}

			stream.end();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const reason = options.signal?.aborted ? "aborted" : "error";
			stream.push(failProxyStream(partial, reason, errorMessage));
			stream.end();
		} finally {
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
			if (reader) {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		}
	})();

	return stream;
}
