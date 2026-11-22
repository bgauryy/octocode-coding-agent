import { type AssistantMessage, type AssistantMessageEvent, normalizeContext } from "@octocodeai/octocode-ai";
import { createAbortError } from "@octocodeai/octocode-ai/utils/abort";
import { createEmptyUsage } from "@octocodeai/octocode-ai/utils/assistant-message";
import type { AgentContext, AgentLoopConfig, StreamFn } from "../types.ts";
import type { AgentEventSink } from "./events.ts";

/**
 * The reply a provider gives a request whose signal already aborted, made without preparing or sending one: no
 * context transform, API key, cache warming or provider call. It ends the turn the way a provider's aborted reply does.
 */
export async function abortedAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
): Promise<AssistantMessage> {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: createEmptyUsage(),
		stopReason: "aborted",
		errorMessage: createAbortError().message,
		timestamp: Date.now(),
		thinkingLevel: config.reasoning ?? "off",
	};
	context.messages.push(message);
	await emit({ type: "message_start", message: { ...message } });
	await emit({ type: "message_end", message });
	return message;
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM. `onEvent` sees each stream event first.
 */
export async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
	onEvent?: (event: AssistantMessageEvent) => void,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	const llmMessages = await config.convertToLlm(messages);

	const llmContext = normalizeContext({ messages: llmMessages });

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});
	// Record the requested level, whichever stream function answered.
	const result = async () => Object.assign(await response.result(), { thinkingLevel: config.reasoning ?? "off" });

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		onEvent?.(event);
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
			case "content_update":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}
