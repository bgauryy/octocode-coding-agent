/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import { type AssistantMessage, EventStream, type ToolResultMessage } from "@octocodeai/octocode-ai";
import { createEmptyUsage } from "@octocodeai/octocode-ai/utils/assistant-message";
import { streamAssistantResponse } from "./agent-loop/assistant-stream.ts";
import { EarlyToolCalls } from "./agent-loop/early-start.ts";
import type { AgentEventSink } from "./agent-loop/events.ts";
import { inputCommitter } from "./agent-loop/input.ts";
import { executeToolCalls, failToolCallsFromTruncatedMessage } from "./agent-loop/tool-batch.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentRequestUpdate,
	PrepareNextTurnContext,
	StreamFn,
} from "./types.ts";

export type { AgentEventSink } from "./agent-loop/events.ts";
export { type RunToolCallOptions, runToolCall, type ToolCallHooks } from "./agent-loop/tool-call.ts";

/** The assistant message that ends a run whose loop threw: empty text, the error, no usage. */
export function runFailureMessage(
	model: Pick<AgentLoopConfig["model"], "api" | "provider" | "id">,
	error: unknown,
	aborted: boolean,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/** End a stream whose loop threw the way a failed run ends: an error message, then `agent_end`. */
function endWithFailure(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	error: unknown,
): void {
	const message = runFailureMessage(config.model, error, signal?.aborted === true);
	stream.push({ type: "message_start", message });
	stream.push({ type: "message_end", message });
	stream.push({ type: "turn_end", message, toolResults: [] });
	stream.push({ type: "agent_end", messages: [message] });
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then(
		(messages) => stream.end(messages),
		(error) => endWithFailure(stream, config, signal, error),
	);

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then(
		(messages) => stream.end(messages),
		(error) => endWithFailure(stream, config, signal, error),
	);

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context, messages: [...context.messages] };
	await emit({ type: "agent_start" });
	if (prompts.length) config.onInputSelected?.({ kind: "initial", messages: prompts });
	await emit({ type: "turn_start" });
	const commit = inputCommitter(currentContext, newMessages, emit);
	const input = await config.prepareInput?.({ kind: "initial", messages: prompts }, signal, commit);
	await commit(input?.messages ?? prompts, input?.stop ? signal : undefined);

	if (input?.stop) {
		await emit({ type: "agent_end", messages: newMessages });
		return newMessages;
	}
	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context, messages: [...context.messages] };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/** The config with the model and thinking level an update replaces; `"off"` clears reasoning. */
function withModelUpdate(config: AgentLoopConfig, update: AgentRequestUpdate): AgentLoopConfig {
	return {
		...config,
		model: update.model ?? config.model,
		reasoning:
			update.thinkingLevel === undefined
				? config.reasoning
				: update.thinkingLevel === "off"
					? undefined
					: update.thinkingLevel,
	};
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let lastCompletedTurn: PrepareNextTurnContext | undefined;
	let explicitContinuation = false;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) ?? [];
	let pendingKind: "steer" | "followUp" = "steer";

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			let preparedMessages: AgentMessage[] = [];
			const selected = pendingMessages.length > 0;
			if (selected) config.onInputSelected?.({ kind: pendingKind, messages: pendingMessages });
			if (lastCompletedTurn) {
				const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
				if (nextTurnSnapshot) {
					currentContext = nextTurnSnapshot.context ?? currentContext;
					preparedMessages = nextTurnSnapshot.messages ?? [];
					config = withModelUpdate(config, nextTurnSnapshot);
				}
				// Preparation can be long-running (for example, compaction). Pick up steering
				// queued while it ran. Only poll again if the earlier poll returned nothing;
				// otherwise one-at-a-time mode would deliver two messages in this turn.
				if (pendingMessages.length === 0) {
					pendingMessages = (await config.getSteeringMessages?.()) ?? [];
				}
				await emit({ type: "turn_start" });
			}

			if (!selected && pendingMessages.length)
				config.onInputSelected?.({ kind: pendingKind, messages: pendingMessages });
			const commit = inputCommitter(currentContext, newMessages, emit);
			if (config.prepareInput && pendingMessages.length > 0) {
				await commit(preparedMessages);
				preparedMessages = [];
			}
			const input =
				pendingMessages.length > 0
					? await config.prepareInput?.({ kind: pendingKind, messages: pendingMessages }, signal, commit)
					: undefined;
			await commit([...preparedMessages, ...(input?.messages ?? pendingMessages)], input?.stop ? signal : undefined);
			pendingMessages = [];
			pendingKind = "steer";
			if (input?.stop) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const requestUpdate = await config.prepareRequest?.(
				{
					context: currentContext,
					model: config.model,
					thinkingLevel: config.reasoning ?? "off",
				},
				signal,
			);
			if (requestUpdate) {
				currentContext = requestUpdate.context ?? currentContext;
				config = withModelUpdate(config, requestUpdate);
			}

			// Stream assistant response
			// Early starts (opt-in, parallel only): settled calls the host allows run while the message still streams.
			const early =
				config.earlyStart && config.toolExecution !== "sequential"
					? new EarlyToolCalls(currentContext, config, config.earlyStart, signal)
					: undefined;
			// A throw while streaming or running the batch must not leave early runs going or the signal linked.
			const requestConfig = requestUpdate?.toolChoice ? { ...config, toolChoice: requestUpdate.toolChoice } : config;
			const message = await streamAssistantResponse(
				currentContext,
				requestConfig,
				signal,
				emit,
				streamFunction,
				(event) => early?.observe(event),
			).catch((error: unknown) => {
				early?.discard();
				throw error;
			});
			newMessages.push(message);
			// A message cut by error, abort or the output limit runs none of its calls, early ones included.
			if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length")
				early?.discard();

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				lastCompletedTurn = {
					message,
					toolResults: [],
					context: currentContext,
					newMessages,
				};
				await config.finishTurn?.(lastCompletedTurn, signal);
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length === 0) early?.dispose();
			if (toolCalls.length > 0) {
				// A "length" stop means the output was cut off by the token limit, so
				// every tool call in the message may carry truncated arguments. Fail
				// them all instead of executing potentially borked calls.
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, message, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit, early?.take(toolCalls)).catch(
								(error: unknown) => {
									early?.discard();
									throw error;
								},
							);
				early?.dispose();
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			lastCompletedTurn = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const abortedBeforeBoundary = signal?.aborted;
			const decision = await config.finishTurn?.(lastCompletedTurn, signal);
			await emit({ type: "turn_end", message, toolResults });

			// A boundary can veto continuation after a completed tool batch. A run aborted earlier, during its tools,
			// deliberately goes on: queued steering is committed, and the next request returns at once as an aborted
			// assistant message that marks the interruption in the transcript (pinned by the session runtime tests).
			if ((!abortedBeforeBoundary && signal?.aborted) || decision?.action === "end") {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			explicitContinuation = decision?.action === "continue";
			pendingMessages = (await config.getSteeringMessages?.()) ?? [];
			if (hasMoreToolCalls || pendingMessages.length > 0) {
				explicitContinuation = false;
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) ?? [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			explicitContinuation = false;
			pendingMessages = followUpMessages;
			pendingKind = "followUp";
			continue;
		}

		// No natural request was selected, so fulfill the continuation decision with one context-only turn.
		if (explicitContinuation) {
			explicitContinuation = false;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}
