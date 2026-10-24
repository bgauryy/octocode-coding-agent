import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import type { AssistantMessage, Model, StreamOptions } from "../../types.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { processResponsesStream } from "../openai-responses-shared/stream-processing.ts";
import { CodexApiError, ProviderStreamEventCallbackError } from "./errors.ts";
import { applyServiceTierPricing, resolveCodexServiceTier } from "./request.ts";
import { parseSSE } from "./sse.ts";
import { CODEX_RESPONSE_STATUSES, type CodexResponseStatus, type OpenAICodexResponsesOptions } from "./types.ts";

// ============================================================================
// Response Processing
// ============================================================================

export async function processStream(
	response: Response,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	options?: OpenAICodexResponsesOptions,
): Promise<void> {
	await processResponsesStream(
		mapCodexEvents(parseSSE(response, options?.signal), output, model, options?.onProviderStreamEvent),
		output,
		stream,
		model,
		{
			serviceTier: options?.serviceTier,
			grammarToolInputProperties,
			resolveServiceTier: resolveCodexServiceTier,
			applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
		},
	);
}

function extractCodexEventError(event: Record<string, unknown>): { code?: string; message?: string } {
	const nested = event.error && typeof event.error === "object" ? (event.error as Record<string, unknown>) : undefined;
	return {
		code: typeof event.code === "string" ? event.code : typeof nested?.code === "string" ? nested.code : undefined,
		message:
			typeof event.message === "string"
				? event.message
				: typeof nested?.message === "string"
					? nested.message
					: undefined,
	};
}

export async function* mapCodexEvents(
	events: AsyncIterable<Record<string, unknown>>,
	output: AssistantMessage,
	model: Model<"openai-codex-responses">,
	onProviderStreamEvent: StreamOptions["onProviderStreamEvent"] | undefined,
): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		try {
			await onProviderStreamEvent?.(event, model);
		} catch (error) {
			// Keep callback failures out of Codex's WebSocket retry and SSE fallback path.
			throw new ProviderStreamEventCallbackError(error);
		}
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		if (type === "error") {
			const { code, message } = extractCodexEventError(event);
			throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
				code,
				payload: event,
			});
		}

		if (type === "response.failed") {
			const response = (event as { response?: { error?: { code?: string; message?: string } } }).response;
			const code = response?.error?.code;
			const message = response?.error?.message;
			throw new CodexApiError(message || "Codex response failed", { code, payload: event });
		}

		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			const response = (event as { response?: { status?: unknown; end_turn?: unknown } }).response;
			if (typeof response?.end_turn === "boolean") {
				output.endTurn = response.end_turn;
			}
			const normalizedResponse = response ? { ...response, status: normalizeCodexStatus(response.status) } : response;
			yield { ...event, type: "response.completed", response: normalizedResponse } as ResponseStreamEvent;
			return;
		}

		yield event as unknown as ResponseStreamEvent;
	}
}

function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
	if (typeof status !== "string") return undefined;
	return CODEX_RESPONSE_STATUSES.has(status as CodexResponseStatus) ? (status as CodexResponseStatus) : undefined;
}
