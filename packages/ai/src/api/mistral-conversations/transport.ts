import type { Model } from "../../types.ts";
import { combineAbortSignals } from "../../utils/abort-signals.ts";
import { safeJsonStringify, truncateErrorText } from "../../utils/error-body.ts";
import { headersToRecord } from "../../utils/headers.ts";
import { getPiUserAgent } from "../../utils/pi-user-agent.ts";
import { shouldUsePromptCaching } from "./request.ts";
import type {
	MistralChatMessage,
	MistralChatPayload,
	MistralCompletionEvent,
	MistralContentChunk,
	MistralOptions,
} from "./types.ts";

const MAX_MISTRAL_ERROR_BODY_CHARS = 4000;

export function formatMistralError(error: unknown): string {
	if (error instanceof Error) {
		const httpError = error as Error & { statusCode?: unknown; body?: unknown };
		const statusCode = typeof httpError.statusCode === "number" ? httpError.statusCode : undefined;
		const bodyText = typeof httpError.body === "string" ? httpError.body.trim() : undefined;
		if (statusCode !== undefined && bodyText) {
			return `Mistral API error (${statusCode}): ${truncateErrorText(bodyText, MAX_MISTRAL_ERROR_BODY_CHARS)}`;
		}
		if (statusCode !== undefined) return `Mistral API error (${statusCode}): ${error.message}`;
		return error.message;
	}
	return safeJsonStringify(error);
}

export async function requestMistralStream(
	model: Model<"mistral-conversations">,
	payload: MistralChatPayload,
	apiKey: string,
	options?: MistralOptions,
): Promise<AsyncIterable<MistralCompletionEvent>> {
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
		response = await (options?.fetch ?? globalThis.fetch)(url, {
			method: "POST",
			headers,
			body: JSON.stringify(toMistralWirePayload(payload)),
			signal: combinedSignal.signal,
		});
	} catch (error) {
		if (headerTimeoutSignal.aborted && !options?.signal?.aborted) {
			throw new Error(`Mistral response headers timed out after ${timeoutMs}ms`);
		}
		throw error;
	} finally {
		combinedSignal.cleanup();
	}

	await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

	if (!response.ok) {
		const body = await response.text();
		throw new MistralHttpError(response.status, body, response.statusText);
	}
	if (!response.body) {
		throw new Error("Mistral response has no body");
	}

	return readMistralEvents(response.body, options?.signal);
}

class MistralHttpError extends Error {
	statusCode: number;
	body: string;

	constructor(statusCode: number, body: string, statusText: string) {
		super(statusText || `Request failed with status ${statusCode}`);
		this.name = "MistralHttpError";
		this.statusCode = statusCode;
		this.body = body;
	}
}

function buildMistralHeaders(model: Model<"mistral-conversations">, apiKey: string, options?: MistralOptions): Headers {
	const headers = new Headers({
		"User-Agent": getPiUserAgent(),
		accept: "text/event-stream",
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json",
	});
	applyMistralHeaderOverrides(headers, model.headers);
	applyMistralHeaderOverrides(headers, options?.headers);

	const hasExplicitAffinity =
		hasMistralHeaderOverride(model.headers, "x-affinity") || hasMistralHeaderOverride(options?.headers, "x-affinity");
	if (shouldUsePromptCaching(options) && !hasExplicitAffinity) {
		headers.set("x-affinity", options.sessionId);
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

const MISTRAL_STREAM_DONE = Symbol("mistral-stream-done");

async function* readMistralEvents(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal | undefined,
): AsyncGenerator<MistralCompletionEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const onAbort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			if (signal?.aborted) throw signal.reason;
			const { done, value } = await reader.read();
			if (signal?.aborted) throw signal.reason;
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

			let boundary = findMistralEventBoundary(buffer);
			while (boundary) {
				const event = parseMistralEvent(buffer.slice(0, boundary.index));
				buffer = buffer.slice(boundary.index + boundary.length);
				if (event === MISTRAL_STREAM_DONE) return;
				if (event) yield event;
				boundary = findMistralEventBoundary(buffer);
			}

			if (done) break;
		}

		if (buffer.trim()) {
			const event = parseMistralEvent(buffer);
			if (event !== MISTRAL_STREAM_DONE && event) yield event;
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

function findMistralEventBoundary(buffer: string): { index: number; length: number } | undefined {
	const match = /\r\n\r\n|\r\n\r|\r\n\n|\r\r\n|\n\r\n|\r\r|\n\r|\n\n/u.exec(buffer);
	return match?.index === undefined ? undefined : { index: match.index, length: match[0].length };
}

function parseMistralEvent(raw: string): MistralCompletionEvent | typeof MISTRAL_STREAM_DONE | undefined {
	const data = raw
		.split(/\r\n|\r|\n/u)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n")
		.trim();
	if (!data) return undefined;
	if (data === "[DONE]") return MISTRAL_STREAM_DONE;

	const parsed: unknown = JSON.parse(data);
	if (!isMistralRecord(parsed) || !Array.isArray(parsed.choices)) {
		throw new Error("Invalid Mistral streaming event");
	}
	return { data: parsed as MistralCompletionEvent["data"] };
}
