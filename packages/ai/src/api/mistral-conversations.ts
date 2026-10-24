import { createPendingAssistantMessage } from "../utils/assistant-message.ts";
import { clampThinkingLevel } from "../models.ts";
import type { Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { failStreamTask } from "./lazy.ts";
import { resolveTranscript } from "../utils/transcript.ts";
import { buildChatPayload } from "./mistral-conversations/request.ts";
import { consumeChatStream } from "./mistral-conversations/stream-events.ts";
import { createMistralToolCallIdNormalizer } from "./mistral-conversations/tool-call-ids.ts";
import { formatMistralError, requestMistralStream } from "./mistral-conversations/transport.ts";
import type { MistralChatPayload, MistralOptions, MistralReasoningEffort } from "./mistral-conversations/types.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

export type { MistralOptions } from "./mistral-conversations/types.ts";

/**
 * Stream responses from the native Mistral Chat Completions endpoint.
 */
export const stream: StreamFunction<"mistral-conversations", MistralOptions> = (
	model: Model<"mistral-conversations">,
	context: TranscriptContext,
	options?: MistralOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	// Mistral rejects a user message after a tool result ("Unexpected role 'user' after role 'tool'"). A later
	// system update therefore never rewrites the leading prompt: it follows an assistant turn or merges into the
	// next user message.
	const normalizedContext = resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages, {
		holdAfterToolResult: true,
	});

	(async () => {
		const output = createPendingAssistantMessage(model);

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const normalizeMistralToolCallId = createMistralToolCallIdNormalizer();
			const transformedMessages = transformMessages(normalizedContext.messages, model, (id) =>
				normalizeMistralToolCallId(id),
			);

			let payload = buildChatPayload(model, normalizedContext, transformedMessages, options);
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined) {
				payload = nextPayload as MistralChatPayload;
			}
			const mistralStream = await requestMistralStream(model, payload, apiKey, options);
			stream.push({ type: "start", partial: output });
			await consumeChatStream(model, output, stream, mistralStream, options?.onProviderStreamEvent);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Mistral stream ended without a finish reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				// partialArgs is only a streaming scratch buffer; never persist it.
				delete (block as { partialArgs?: string }).partialArgs;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatMistralError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})().catch((error: unknown) => failStreamTask(stream, model, error, options?.signal));

	return stream;
};

/**
 * Maps provider-agnostic `SimpleStreamOptions` to Mistral options.
 */
export const streamSimple: StreamFunction<"mistral-conversations", SimpleStreamOptions> = (
	model: Model<"mistral-conversations">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies MistralOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoning = clampedReasoning === "off" ? undefined : clampedReasoning;
	// Models with a thinking level map use `reasoning_effort`; other reasoning models use `prompt_mode`.
	const effortMap = model.reasoning ? model.thinkingLevelMap : undefined;
	const reasoningEffort = effortMap
		? reasoning
			? (effortMap[reasoning] ?? "high")
			: (effortMap.off ?? undefined)
		: undefined;

	return stream(model, context, {
		...base,
		promptMode: model.reasoning && !effortMap && reasoning ? "reasoning" : undefined,
		reasoningEffort: reasoningEffort as MistralReasoningEffort | undefined,
	} satisfies MistralOptions);
};
