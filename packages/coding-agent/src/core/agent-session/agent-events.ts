/**
 * The session's handling of Agent events: feature dispatch, listener notification, session
 * persistence and per-turn bookkeeping, in that order.
 */

import type { AgentEvent, AgentMessage } from "@octocodeai/octocode-agent-core";
import type {
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnStartEvent,
} from "../features/index.ts";
import { releaseSavedOutput } from "../tools/bash/stored-result.ts";
import type { SessionBoundaries } from "./boundaries.ts";
import type { SessionInternals } from "./host.ts";
import type { SessionInputQueue } from "./input-queue.ts";
import { replaceMessageInPlace } from "./messages.ts";
import type { ModelWaitWatch } from "./model-wait.ts";
import type { SessionRetry } from "./retry.ts";
import { recordRunMessage } from "./run-outcome.ts";
import type { SessionToolCalls } from "./tool-calls.ts";
import type { AssistantMessage } from "@octocodeai/octocode-ai";

export interface AgentEventsHost extends Pick<SessionInternals, "session" | "run" | "emit"> {
	readonly inputs: SessionInputQueue;
	readonly retry: SessionRetry;
	readonly modelWait: ModelWaitWatch;
	readonly boundaries: SessionBoundaries;
	readonly toolCalls: SessionToolCalls;
	/** The session's `_emitFeatureEvent`. */
	emitFeatureEvent(event: AgentEvent): Promise<void>;
	observeContextCapacity(message: AssistantMessage): void;
}

/** Internal handler for agent events - shared by subscribe and reconnect */
export async function handleAgentEvent(host: AgentEventsHost, event: AgentEvent, signal?: AbortSignal): Promise<void> {
	const { session, run } = host;
	// An abort requested while the run was starting, e.g. during before_agent_start, stops it
	// here. agent_start is awaited before the first request.
	if (event.type === "agent_start") {
		run.lengthContinuations = 0;
		run.truncatedToolTurns = 0;
	}
	if (event.type === "agent_start" && run.agentRunAbortRequested) session.agent.abort();
	// Record the calls a tool made through ctx.executeTool() and their usage on its result message.
	host.toolCalls.recordNestedCalls(event);
	host.modelWait.observe(event);
	// When a user message starts, check if it's from either queue and remove it BEFORE emitting
	// This ensures the UI sees the updated queue state
	if (event.type === "message_start" && event.message.role === "user") {
		run.overflowRecoveryAttempted = false;
		host.inputs.consumeQueuedUserMessage(event.message);
	}

	// The call has returned and its end event carried the result: from here a bash result's copy of its output for
	// programmatic callers (up to 1 MiB) is read from its saved file when read, as after a resume.
	if (event.type === "message_start" && event.message.role === "toolResult") releaseSavedOutput(event.message);

	if (event.type === "message_end" && event.message.role === "assistant" && !signal?.aborted)
		host.observeContextCapacity(event.message);
	// Emit to features first, then notify public listeners.
	await host.emitFeatureEvent(event);
	// After an abort the agent stops waiting for a streaming delta's delivery, so this one may resume after its run
	// ended, even during the next run. Its final state comes with message_end or tool_execution_end: drop it.
	if (signal?.aborted && (event.type === "message_update" || event.type === "tool_execution_update")) return;
	host.emit(event.type === "agent_end" ? { ...event, willRetry: host.retry.willRetryAfterAgentEnd(event) } : event);

	// Handle session persistence
	if (event.type === "message_end") {
		// Before the append, which can throw: the run's outcome must not depend on the disk.
		if (event.message.role === "assistant") recordRunMessage(run.outcome, event.message);
		let entryId: string | undefined;
		if (event.message.role === "custom") {
			entryId = session.sessionManager.appendCustomMessageEntry(
				event.message.customType,
				event.message.content,
				event.message.display,
				event.message.details,
				event.message.timestamp,
			);
		} else if (
			event.message.role === "system" ||
			event.message.role === "user" ||
			event.message.role === "assistant" ||
			event.message.role === "toolResult"
		) {
			// Regular LLM message - persist as SessionMessageEntry
			entryId = session.sessionManager.appendMessage(
				event.message,
				event.message.role === "user" ? host.inputs.originOf(event.message) : undefined,
			);
		}
		if (entryId) host.boundaries.recordEntryId(event.message, entryId);
		// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

		if (event.message.role === "assistant") {
			const assistantMsg = event.message;
			run.lastAssistantMessage = assistantMsg;
			if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
				run.overflowRecoveryAttempted = false;
			}

			// Reset retry counter immediately on successful assistant response
			// This prevents accumulation across multiple LLM calls within a turn
			if (assistantMsg.stopReason !== "error" && host.retry.attempt > 0) {
				host.retry.finishSucceeded();
			}
		}
	}

	// A turn ends after its assistant message and every tool result has been appended,
	// so this is the first point in the run where a context-only custom message can be
	// inserted without landing between a tool call and its result. Flushing after the
	// feature and listener dispatch above also picks up messages that turn_end
	// handlers queued.
	if (event.type === "turn_end") {
		host.inputs.flushDuringRun(run.outcome);
	}
}

export async function emitFeatureEvent(
	host: Pick<AgentEventsHost, "session" | "run" | "boundaries">,
	event: AgentEvent,
): Promise<void> {
	const { session, run } = host;
	if (event.type === "agent_start") {
		run.turnIndex = 0;
		await session.featureHost.emit({ type: "agent_start" });
	} else if (event.type === "agent_end") {
		await session.featureHost.emit({
			type: "agent_end",
			messages: event.messages,
		});
	} else if (event.type === "turn_start") {
		const featureEvent: TurnStartEvent = {
			type: "turn_start",
			turnIndex: run.turnIndex,
			timestamp: Date.now(),
		};
		await session.featureHost.emit(featureEvent);
	} else if (event.type === "turn_end") {
		if (event.message.role === "assistant" && !host.boundaries.takeDispatched(event.message)) {
			await host.boundaries.dispatchTurnEnd(event.message, event.toolResults);
		}
		run.turnIndex++;
	} else if (event.type === "message_start") {
		const featureEvent: MessageStartEvent = {
			type: "message_start",
			message: event.message,
		};
		await session.featureHost.emit(featureEvent);
	} else if (event.type === "message_update") {
		const featureEvent: MessageUpdateEvent = {
			type: "message_update",
			message: event.message,
			assistantMessageEvent: event.assistantMessageEvent,
		};
		await session.featureHost.emit(featureEvent);
	} else if (event.type === "message_end") {
		const featureEvent: MessageEndEvent = {
			type: "message_end",
			message: event.message,
		};
		const replacement = await session.featureHost.emitMessageEnd(featureEvent);
		if (replacement) {
			// Untyped feature handlers can return messages with null/missing content;
			// normalize so it never enters agent state or session history.
			const normalized =
				(replacement.role === "user" ||
					replacement.role === "assistant" ||
					replacement.role === "toolResult" ||
					replacement.role === "custom") &&
				replacement.content == null
					? ({ ...replacement, content: [] } as AgentMessage)
					: replacement;
			replaceMessageInPlace(event.message, normalized);
		}
	} else if (event.type === "tool_execution_start") {
		const featureEvent: ToolExecutionStartEvent = {
			type: "tool_execution_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		};
		await session.featureHost.emit(featureEvent);
	} else if (event.type === "tool_execution_update") {
		const featureEvent: ToolExecutionUpdateEvent = {
			type: "tool_execution_update",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			partialResult: event.partialResult,
		};
		await session.featureHost.emit(featureEvent);
	} else if (event.type === "tool_execution_end") {
		const featureEvent: ToolExecutionEndEvent = {
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
			...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
		};
		await session.featureHost.emit(featureEvent);
	}
}
