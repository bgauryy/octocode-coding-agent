import { APICallError } from "@ai-sdk/provider";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { combineAbortSignals } from "../../utils/abort-signals.ts";
import { retryProviderRequest } from "../../utils/provider-retry.ts";
import { headersToRecord } from "../../utils/headers.ts";
import { assertImageRequestPayload } from "../../utils/image-input.ts";
import type { Api, Model, StreamOptions } from "../../types.ts";
import { readWithIdleTimeout, resolveStreamIdleTimeoutMs, streamIdleError } from "./stream-idle.ts";
import { iterateSseMessages, throwOnSseErrorEvent } from "../../utils/server-sent-events.ts";

class ResponseHookError extends Error {
	constructor(cause: unknown) {
		super("Response hook failed", { cause });
	}
}

async function cancelResponseBody(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => {});
}

export async function prepareSdkRequest(
	model: Model<Api>,
	options: StreamOptions,
	_input: Parameters<typeof fetch>[0],
	init?: RequestInit,
	augmentRequest?: (body: Record<string, unknown>) => void,
	finalizeRequest?: (body: unknown) => void,
): Promise<RequestInit | undefined> {
	if (typeof init?.body !== "string") return init;
	const body = JSON.parse(init.body) as Record<string, unknown>;
	augmentRequest?.(body);
	const replacement = await options.onPayload?.(body, model);
	const payload = replacement === undefined ? body : replacement;
	finalizeRequest?.(payload);
	assertImageRequestPayload(model, payload);
	return { ...init, body: JSON.stringify(payload) };
}

export async function fetchSdkResponse(
	model: Model<Api>,
	options: StreamOptions,
	input: Parameters<typeof fetch>[0],
	init?: RequestInit,
	augmentRequest?: (body: Record<string, unknown>) => void,
	finalizeRequest?: (body: unknown) => void,
): Promise<Response> {
	const url = input instanceof Request ? input.url : input.toString();
	const request = await prepareSdkRequest(model, options, input, init, augmentRequest, finalizeRequest);
	return retryProviderRequest(async () => {
		const deadline = new AbortController();
		const combined = combineAbortSignals([init?.signal ?? options.signal, deadline.signal]);
		const mistral = model.api === "mistral-conversations";
		// Chat completions and Mistral bound only the wait for response headers; the body may stream longer.
		const headersOnly = model.api === "openai-completions" || mistral;
		const timeoutMs = options.timeoutMs ?? (model.api.startsWith("google-") ? undefined : mistral ? 60_000 : 600_000);
		const timeoutMessage = mistral
			? `Mistral response headers timed out after ${timeoutMs}ms`
			: `Request timed out after ${timeoutMs}ms`;
		const timer =
			timeoutMs === undefined ? undefined : setTimeout(() => deadline.abort(new Error(timeoutMessage)), timeoutMs);
		timer?.unref();
		const cleanup = () => {
			clearTimeout(timer);
			combined.cleanup();
		};
		let response: Response;
		try {
			const pending = (options.fetch ?? globalThis.fetch)(input, { ...request, signal: combined.signal });
			void pending.then(
				(late) => {
					if (combined.signal?.aborted) return cancelResponseBody(late);
				},
				() => {},
			);
			response = await raceWithAbortSignal(pending, combined.signal);
			if (response.ok && headersOnly) clearTimeout(timer);
			try {
				await raceWithAbortSignal(
					Promise.resolve(
						options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model),
					),
					combined.signal,
				);
			} catch (error) {
				deadline.abort(error);
				await response.body?.cancel().catch(() => {});
				throw new ResponseHookError(error);
			}
			if (!response.ok) {
				const errorBody = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
					signal: combined.signal,
				});
				const body = await raceWithAbortSignal(new Response(errorBody).text(), combined.signal);
				throw new APICallError({
					message: `${response.status} ${body}`,
					url,
					requestBodyValues: undefined,
					statusCode: response.status,
					responseHeaders: Object.fromEntries(response.headers),
					responseBody: body,
				});
			}
			if (!response.body) {
				cleanup();
				return response;
			}
		} catch (error) {
			cleanup();
			if (combined.signal?.aborted || APICallError.isInstance(error)) throw error;
			throw new APICallError({
				message: error instanceof Error ? error.message : String(error),
				cause: error,
				url,
				requestBodyValues: undefined,
				isRetryable: true,
			});
		}
		const reader = response.body.getReader();
		const idleMs = resolveStreamIdleTimeoutMs(options.streamIdleTimeoutMs);
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const next = await readWithIdleTimeout(raceWithAbortSignal(reader.read(), combined.signal), idleMs, () =>
						streamIdleError(idleMs!, url),
					);
					if (next.done) {
						cleanup();
						reader.releaseLock();
						controller.close();
					} else controller.enqueue(next.value);
				} catch (error) {
					cleanup();
					void reader.cancel(error).catch(() => {});
					controller.error(error);
				}
			},
			async cancel(reason) {
				deadline.abort(reason);
				cleanup();
				await reader.cancel(reason);
			},
		});
		return new Response(body, response);
	}, options).catch((error: unknown) => {
		if (error instanceof ResponseHookError) throw error.cause;
		throw error;
	});
}

export interface TransportState {
	error?: unknown;
	terminal?: boolean;
	streamStarted?: boolean;
	blockedPrompt?: string;
}

export function observeSdkResponse(
	response: Response,
	state: TransportState,
	model: Model<Api>,
	options: StreamOptions,
	signal?: AbortSignal,
): Response {
	if (!response.ok || !response.body) return response;
	state.streamStarted = true;
	const body = response.body;
	const iterator = (async function* () {
		for await (const event of iterateSseMessages(body, signal)) {
			throwOnSseErrorEvent(event);
			if (event.data === "[DONE]") return;
			const parsed = JSON.parse(event.data);
			await options.onProviderStreamEvent?.(parsed, model);
			if (parsed.promptFeedback?.blockReason)
				state.blockedPrompt = parsed.promptFeedback.blockReasonMessage || parsed.promptFeedback.blockReason;
			let normalized = parsed;
			if ((model.api === "google-generative-ai" || model.api === "google-vertex") && Array.isArray(parsed.candidates)) {
				// The SDK otherwise follows continuation tokens with additional billed requests.
				normalized = {
					...parsed,
					candidates: parsed.candidates.map((candidate: Record<string, unknown>) => {
						if (candidate.finishReason !== "CONTINUATION") return candidate;
						const { continuationToken: _token, ...rest } = candidate;
						return rest;
					}),
				};
			}
			if (model.api.endsWith("responses")) {
				// The Codex backend may end with response.done, which the SDK reads as response.completed.
				if (model.api === "openai-codex-responses" && parsed.type === "response.done")
					normalized = { ...parsed, type: "response.completed" };
				if (
					parsed.type === "response.output_item.done" &&
					parsed.item?.type === "function_call" &&
					parsed.item.status === undefined
				)
					normalized = { ...parsed, item: { ...parsed.item, status: "completed" } };
				if (parsed.type === "response.created")
					normalized = { ...parsed, response: { created_at: 0, model: model.id, ...parsed.response } };
				if (["response.completed", "response.incomplete", "response.failed"].includes(normalized.type))
					state.terminal = true;
				if (parsed.type === "response.failed" && parsed.response?.error) {
					const { code, message } = parsed.response.error;
					throw new Error(`${code ? `${code}: ` : ""}${message ?? "Response failed"}`);
				}
			}
			yield new TextEncoder().encode(`data: ${JSON.stringify(normalized)}\n\n`);
			// The Codex backend can hold the body open after its terminal event.
			if (model.api === "openai-codex-responses" && state.terminal) return;
		}
	})();
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { value, done } = await iterator.next();
					if (done) controller.close();
					else controller.enqueue(value);
				} catch (error) {
					state.error = error;
					controller.error(error);
				}
			},
			async cancel() {
				await iterator.return();
			},
		}),
		response,
	);
}
