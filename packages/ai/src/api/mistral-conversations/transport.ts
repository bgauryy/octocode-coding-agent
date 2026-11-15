import { APICallError } from "@ai-sdk/provider";
import { createStatusCodeErrorResponseHandler, postToApi } from "@ai-sdk/provider-utils";
import type { Model } from "../../types.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { retryProviderRequest } from "../../utils/provider-retry.ts";
import { combineAbortSignals } from "../../utils/abort-signals.ts";
import { formatProviderError, normalizeProviderError } from "../../utils/error-body.ts";
import { headersToRecord } from "../../utils/headers.ts";
import { iterateSseMessages, throwOnSseErrorEvent } from "../../utils/server-sent-events.ts";
import { getUserAgent } from "../../utils/user-agent.ts";
import { shouldUsePromptCaching } from "./request.ts";
import type {
	MistralChatMessage,
	MistralChatPayload,
	MistralCompletionEvent,
	MistralContentChunk,
	MistralOptions,
} from "./types.ts";

export function formatMistralError(error: unknown): string {
	return formatProviderError(normalizeProviderError(error), "Mistral API error");
}

export async function requestMistralStream(
	model: Model<"mistral-conversations">,
	payload: MistralChatPayload,
	apiKey: string,
	options?: MistralOptions,
): Promise<AsyncIterable<MistralCompletionEvent>> {
	const response = await retryProviderRequest(() => requestMistralResponse(model, payload, apiKey, options), options);
	try {
		await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	} catch (error) {
		await response.body?.cancel().catch(() => {});
		throw error;
	}
	return readMistralEvents(response.body!, options?.signal);
}

async function requestMistralResponse(
	model: Model<"mistral-conversations">,
	payload: MistralChatPayload,
	apiKey: string,
	options?: MistralOptions,
): Promise<Response> {
	const baseUrl = new URL(model.baseUrl);
	baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/u, "")}/`;
	const url = new URL("v1/chat/completions", baseUrl);
	const headers = buildMistralHeaders(model, apiKey, options);
	// The timeout covers only the wait for response headers. Long streams (e.g. extended thinking)
	// must not be cut off by a fixed deadline; body stalls are left to the HTTP client idle timeout.
	const timeoutMs = options?.timeoutMs ?? 60_000;
	const headerTimeoutSignal = AbortSignal.timeout(timeoutMs);
	// Always combine two signals: the helper returns a single signal unchanged, which
	// would leave the response body attached to the header deadline after cleanup.
	const requestSignal = options?.signal ?? new AbortController().signal;
	const combinedSignal = combineAbortSignals([requestSignal, headerTimeoutSignal]);
	let response: Response;
	try {
		const wirePayload = toMistralWirePayload(payload);
		const pending = postToApi({
			url: url.href,
			headers: Object.fromEntries(headers),
			body: { content: JSON.stringify(wirePayload), values: wirePayload },
			abortSignal: combinedSignal.signal,
			fetch: async (input, init) => {
				// Preserve explicit host header overrides, including removing a default header.
				const received = await (options?.fetch ?? globalThis.fetch)(input, { ...init, headers });
				if (combinedSignal.signal?.aborted) {
					void received.body?.cancel().catch(() => {});
					combinedSignal.signal.throwIfAborted();
				}
				return !received.ok && received.body
					? new Response(received.body.pipeThrough(new TransformStream(), { signal: combinedSignal.signal }), received)
					: received;
			},
			failedResponseHandler: createStatusCodeErrorResponseHandler(),
			successfulResponseHandler: async ({ response }) => ({ value: response }),
		});
		response = (await raceWithAbortSignal(pending, combinedSignal.signal)).value;
	} catch (error) {
		if (headerTimeoutSignal.aborted && !options?.signal?.aborted) {
			throw Object.assign(new Error(`Mistral response headers timed out after ${timeoutMs}ms`), {
				status: undefined,
				headers: undefined,
			});
		}
		if (error instanceof Error && !APICallError.isInstance(error))
			throw Object.assign(error, { status: undefined, headers: undefined });
		throw error;
	} finally {
		combinedSignal.cleanup();
	}

	if (!response.body) throw new Error("Mistral response has no body");
	return response;
}

function buildMistralHeaders(model: Model<"mistral-conversations">, apiKey: string, options?: MistralOptions): Headers {
	const headers = new Headers({
		"User-Agent": getUserAgent(),
		accept: "text/event-stream",
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json",
	});
	applyMistralHeaderOverrides(headers, model.headers);
	applyMistralHeaderOverrides(headers, options?.headers);

	const hasExplicitAffinity =
		hasMistralHeaderOverride(model.headers, "x-affinity") || hasMistralHeaderOverride(options?.headers, "x-affinity");
	if (shouldUsePromptCaching(options) && !hasExplicitAffinity) {
		// A fork continues its parent's conversation, so it pins to the replica holding the parent's prefix. A sibling
		// child shares a cache key through the environment but keeps its own affinity.
		headers.set("x-affinity", options.promptCacheKey ?? options.sessionId);
	}

	return headers;
}

function applyMistralHeaderOverrides(headers: Headers, overrides?: Record<string, string | null>): void {
	if (!overrides) return;
	for (const [name, value] of Object.entries(overrides)) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}
}

function hasMistralHeaderOverride(overrides: Record<string, string | null> | undefined, target: string): boolean {
	return !!overrides && Object.keys(overrides).some((name) => name.toLowerCase() === target);
}

function toMistralWirePayload(payload: MistralChatPayload): Record<string, unknown> {
	const wirePayload: Record<string, unknown> = { ...payload };
	for (const [source, target] of [
		["topP", "top_p"],
		["maxTokens", "max_tokens"],
		["randomSeed", "random_seed"],
		["responseFormat", "response_format"],
		["toolChoice", "tool_choice"],
		["presencePenalty", "presence_penalty"],
		["frequencyPenalty", "frequency_penalty"],
		["parallelToolCalls", "parallel_tool_calls"],
		["reasoningEffort", "reasoning_effort"],
		["promptMode", "prompt_mode"],
		["promptCacheKey", "prompt_cache_key"],
		["safePrompt", "safe_prompt"],
	] as const) {
		remapMistralProperty(wirePayload, source, target);
	}
	wirePayload.messages = payload.messages.map((message) => toMistralWireMessage(message));

	const responseFormat = wirePayload.response_format;
	if (isMistralRecord(responseFormat)) {
		const wireResponseFormat = { ...responseFormat };
		remapMistralProperty(wireResponseFormat, "jsonSchema", "json_schema");
		const jsonSchema = wireResponseFormat.json_schema;
		if (isMistralRecord(jsonSchema)) {
			const wireJsonSchema = { ...jsonSchema };
			remapMistralProperty(wireJsonSchema, "schemaDefinition", "schema");
			wireResponseFormat.json_schema = wireJsonSchema;
		}
		wirePayload.response_format = wireResponseFormat;
	}

	return wirePayload;
}

function toMistralWireMessage(message: MistralChatMessage): Record<string, unknown> {
	const wireMessage: Record<string, unknown> = { ...message };
	remapMistralProperty(wireMessage, "toolCalls", "tool_calls");
	remapMistralProperty(wireMessage, "toolCallId", "tool_call_id");
	if (Array.isArray(message.content)) {
		wireMessage.content = message.content.map((chunk) => toMistralWireContentChunk(chunk));
	}
	return wireMessage;
}

function toMistralWireContentChunk(chunk: MistralContentChunk): Record<string, unknown> {
	const wireChunk: Record<string, unknown> = { ...chunk };
	for (const [source, target] of [
		["imageUrl", "image_url"],
		["documentUrl", "document_url"],
		["documentName", "document_name"],
		["fileId", "file_id"],
		["referenceIds", "reference_ids"],
		["inputAudio", "input_audio"],
	] as const) {
		remapMistralProperty(wireChunk, source, target);
	}
	return wireChunk;
}

function remapMistralProperty(record: Record<string, unknown>, source: string, target: string): void {
	if (!(source in record)) return;
	record[target] = record[source];
	delete record[source];
}

function isMistralRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function* readMistralEvents(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal | undefined,
): AsyncGenerator<MistralCompletionEvent> {
	for await (const event of iterateSseMessages(body, signal)) {
		throwOnSseErrorEvent(event);
		const data = event.data.trim();
		if (!data) continue;
		if (data === "[DONE]") return;
		const parsed: unknown = JSON.parse(data);
		if (!isMistralRecord(parsed) || !Array.isArray(parsed.choices)) throw new Error("Invalid Mistral streaming event");
		yield { data: parsed as MistralCompletionEvent["data"] };
	}
}
