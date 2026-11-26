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
import type { EarlyRun } from "./early-start.ts";
import { sinceMs, toolCallPhases } from "./tool-timing.ts";
import { resolveToolConcurrency, ToolSchedule } from "./tool-schedule.ts";

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
 * Execute tool calls from an assistant message. Sequential when the loop says so; else each call starts as soon as its own
 * preparation ends, shared or exclusive by its tool (`resolveToolConcurrency`), so a slow approval of one call no longer
 * holds back the calls approved before it.
 */
export async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	early: readonly EarlyRun[] = [],
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	if (config.toolExecution === "sequential") {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit, early);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
	halted?: boolean;
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
	let halted = false;

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
			if (preparation.halt) halted = true;
			finalized = immediateOutcome(toolCall, preparation);
		} else {
			const executed = await executePreparedToolCall(
				preparation,
				signal,
				emitToolExecutionUpdate(toolCall, emit),
				config.onListenerError,
			);
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

		if (signal?.aborted || halted) {
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
		terminate: halted || shouldTerminateToolBatch(finalizedCalls),
		...(halted ? { halted: true } : {}),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	early: readonly EarlyRun[],
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: Array<AgentToolCallOutcome | Promise<AgentToolCallOutcome>> = [];
	const schedule = new ToolSchedule();
	let halted = false;
	let orderedFinalizedCalls: AgentToolCallOutcome[];

	try {
		for (const [index, toolCall] of toolCalls.entries()) {
			await emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});

			const earlyPreparation = await early[index]?.preparation;
			// A deferred early attempt left no trace: the call is prepared now, as any call that was not started early.
			const earlyRun = earlyPreparation?.kind === "deferred" ? undefined : early[index];
			const preparation =
				earlyPreparation && earlyPreparation.kind !== "deferred"
					? earlyPreparation
					: await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
			if (preparation.kind === "immediate") {
				if (preparation.halt) halted = true;
				const finalized = immediateOutcome(toolCall, preparation);
				await emitToolExecutionEnd(finalized, emit);
				finalizedCalls.push(finalized);
				if (signal?.aborted || halted) {
					finalizedCalls.push(...(await skipRemainingToolCalls(toolCalls.slice(index + 1), emit)));
					break;
				}
				continue;
			}

			if (earlyRun) {
				// Already running, shared: it joins the schedule so a later exclusive call still waits for it.
				finalizedCalls.push(
					schedule.add("shared", async () => {
						const delivered = earlyRun.attach(emitToolExecutionUpdate(toolCall, emit));
						const executed = (await earlyRun.executed)!;
						await delivered;
						const finalized = await finalizeExecutedToolCall(
							currentContext,
							assistantMessage,
							preparation,
							executed,
							config,
							signal,
						);
						// Its preparation overlapped the model's stream, so it did not delay the batch.
						const phases = toolCallPhases({ ...finalized.phases, early: true });
						if (phases) finalized.phases = phases;
						await emitToolExecutionEnd(finalized, emit);
						return finalized;
					}),
				);
				continue;
			}
			const concurrency = resolveToolConcurrency(preparation.tool, preparation.args);
			const queuedAt = performance.now();
			finalizedCalls.push(
				schedule.add(concurrency, () =>
					runPreparedToolCall(currentContext, assistantMessage, preparation, config, signal, emit, sinceMs(queuedAt)),
				),
			);
			if (signal?.aborted) {
				finalizedCalls.push(...(await skipRemainingToolCalls(toolCalls.slice(index + 1), emit)));
				break;
			}
		}

		const pending = finalizedCalls.map(async (entry) => entry);
		orderedFinalizedCalls = await Promise.all(pending);
	} catch (error) {
		const pending = finalizedCalls.map(async (entry) => entry);
		if (pending.length > 0) config.onAbandonedTools?.(allEnded(pending));
		throw error;
	}
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: halted || shouldTerminateToolBatch(orderedFinalizedCalls),
		...(halted ? { halted: true } : {}),
	};
}

/** Resolves once every call has ended, however it ended. */
async function allEnded(calls: readonly Promise<unknown>[]): Promise<void> {
	await Promise.allSettled(calls);
}

/** Execute and finalize one prepared call, emitting its end; a call reached after an abort reports "Operation aborted". */
async function runPreparedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	preparation: Extract<Awaited<ReturnType<typeof prepareToolCall>>, { kind: "prepared" }>,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	queuedMs: number,
): Promise<AgentToolCallOutcome> {
	const { toolCall } = preparation;
	if (signal?.aborted) {
		const finalized = {
			toolCall,
			result: createErrorToolResult("Operation aborted"),
			isError: true,
		} satisfies AgentToolCallOutcome;
		await emitToolExecutionEnd(finalized, emit);
		return finalized;
	}
	const executed = await executePreparedToolCall(
		preparation,
		signal,
		emitToolExecutionUpdate(toolCall, emit),
		config.onListenerError,
	);
	const finalized = await finalizeExecutedToolCall(
		currentContext,
		assistantMessage,
		preparation,
		executed,
		config,
		signal,
	);
	const phases = toolCallPhases({ ...finalized.phases, queuedMs });
	if (phases) finalized.phases = phases;
	await emitToolExecutionEnd(finalized, emit);
	return finalized;
}

/** The outcome of a call that ended in preparation (unknown tool, invalid arguments, blocked or aborted). */
function immediateOutcome(
	toolCall: AgentToolCall,
	preparation: Extract<Awaited<ReturnType<typeof prepareToolCall>>, { kind: "immediate" }>,
): AgentToolCallOutcome {
	const phases = toolCallPhases({ prepareMs: preparation.prepareMs });
	return {
		toolCall,
		result: preparation.result,
		isError: preparation.isError,
		...(phases ? { phases } : {}),
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

function shouldTerminateToolBatch(finalizedCalls: AgentToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}
