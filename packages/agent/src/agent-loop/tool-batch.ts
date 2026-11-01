import type { AssistantMessage, ToolResultMessage } from "@octocodeai/octocode-ai";
import type { AgentContext, AgentLoopConfig, AgentToolCall, AgentToolCallOutcome } from "../types.ts";
import {
	type AgentEventSink,
	createToolResultMessage,
	emitToolExecutionEnd,
	emitToolExecutionUpdate,
	emitToolResultMessage,
} from "./events.ts";
import {
	createErrorToolResult,
	executePreparedToolCall,
	finalizeExecutedToolCall,
	prepareToolCall,
} from "./tool-call.ts";

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 *
 * Sending the same oversized call again reaches the same limit, so the message names the limit and
 * asks for smaller pieces.
 */
export async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	assistantMessage: AssistantMessage,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: AgentToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(describeTruncatedToolCall(toolCall, assistantMessage)),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

function describeTruncatedToolCall(toolCall: AgentToolCall, assistantMessage: AssistantMessage): string {
	const limit = assistantMessage.usage.output > 0 ? ` (${assistantMessage.usage.output} tokens)` : "";
	if (toolCall.argumentsError === undefined) {
		return `Tool call "${toolCall.name}" was not executed: the response reached the model's output limit${limit} before it ended, so this call cannot be confirmed complete. Send it again, and keep the whole response well under the limit by splitting long content across several calls.`;
	}
	const cutAfter = toolCall.rawArguments === undefined ? "" : ` after ${toolCall.rawArguments.length} characters`;
	return `Tool call "${toolCall.name}" was not executed: the response reached the model's output limit${limit} in the middle of this call, so its arguments were cut off${cutAfter}. Sending the same call again reaches the same limit. Send it again in smaller pieces: split long content across several calls, each well under the limit, or shorten it.`;
}

/**
 * Execute tool calls from an assistant message.
 */
export async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: AgentToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const [index, toolCall] of toolCalls.entries()) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: AgentToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emitToolExecutionUpdate(toolCall, emit));
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			for (const skipped of await skipRemainingToolCalls(toolCalls.slice(index + 1), emit)) {
				const skippedMessage = createToolResultMessage(skipped);
				await emitToolResultMessage(skippedMessage, emit);
				finalizedCalls.push(skipped);
				messages.push(skippedMessage);
			}
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const [index, toolCall] of toolCalls.entries()) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies AgentToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				finalizedCalls.push(...(await skipRemainingToolCalls(toolCalls.slice(index + 1), emit)));
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			if (signal?.aborted) {
				const finalized = {
					toolCall,
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				} satisfies AgentToolCallOutcome;
				await emitToolExecutionEnd(finalized, emit);
				return finalized;
			}
			const executed = await executePreparedToolCall(preparation, signal, emitToolExecutionUpdate(toolCall, emit));
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			finalizedCalls.push(...(await skipRemainingToolCalls(toolCalls.slice(index + 1), emit)));
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

/**
 * Record an aborted result for each call the loop did not reach, so every assistant tool call
 * has a start, an end and a result. Without this the transcript keeps orphaned calls that only
 * a provider adapter repairs.
 */
async function skipRemainingToolCalls(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<AgentToolCallOutcome[]> {
	const skipped: AgentToolCallOutcome[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: AgentToolCallOutcome = {
			toolCall,
			result: createErrorToolResult("Operation aborted"),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		skipped.push(finalized);
	}
	return skipped;
}

type FinalizedToolCallEntry = AgentToolCallOutcome | (() => Promise<AgentToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: AgentToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}
