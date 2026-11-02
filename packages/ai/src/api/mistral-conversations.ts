import { createAbortError } from "../utils/abort.ts";
import { assertImageRequestPayload } from "../utils/image-input.ts";
import { retryAfterMsFromError } from "../utils/provider-retry.ts";
import { createPendingAssistantMessage } from "../utils/assistant-message.ts";
import { clampThinkingLevel } from "../models/model-helpers.ts";
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

	(async () => {
		const output = createPendingAssistantMessage(model);

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const normalizeMistralToolCallId = createMistralToolCallIdNormalizer();
			const transformedMessages = transformMessages(context.messages, model, (id) => normalizeMistralToolCallId(id));
			// Harness-generated system updates use a conservative placement policy after tool results. This does not
			// prohibit actual user input after a tool result: mistral-common and the Ministral 3 template allow that
			// order, including after an interrupted turn; hosted endpoint compatibility is not established by them.
			// An update that changes the prompt right after a tool result is folded into the leading prompt, so its text
			// reaches the model in the same request as the tools it describes; this rewrites the cached head once per
			// such update. Other updates follow an assistant turn or merge into the next user message. Updates are
			// placed after the transform, which drops errored and aborted turns and answers orphaned calls: placed
			// before it, an update after such a turn would land right after a tool result.
			const normalizedContext = resolveTranscript(
				{ messages: transformedMessages } as TranscriptContext,
				model.compat?.supportsMidConvoSystemMessages,
				{ holdAfterToolResult: true },
			);

			let payload = buildChatPayload(model, normalizedContext, normalizedContext.messages, options);
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined) {
				payload = nextPayload as MistralChatPayload;
			}
			assertImageRequestPayload(model, payload);
			const mistralStream = await requestMistralStream(model, payload, apiKey, options);
			stream.push({ type: "start", partial: output });
			await consumeChatStream(model, output, stream, mistralStream, options?.onProviderStreamEvent);

			if (options?.signal?.aborted) {
				throw createAbortError();
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
			const retryAfterMs = retryAfterMsFromError(error);
			if (retryAfterMs !== undefined) output.retryAfterMs = retryAfterMs;
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
