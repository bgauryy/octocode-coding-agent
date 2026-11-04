/**
 * The session's handling of Agent events: extension dispatch, listener notification, session
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
import type { SessionBoundaries } from "./boundaries.ts";
import type { SessionInternals } from "./host.ts";
import type { SessionInputQueue } from "./input-queue.ts";
import { replaceMessageInPlace } from "./messages.ts";
import type { SessionRetry } from "./retry.ts";
import { recordRunMessage } from "./run-outcome.ts";
import type { SessionToolCalls } from "./tool-calls.ts";

export interface AgentEventsHost extends Pick<SessionInternals, "session" | "run" | "emit"> {
	readonly inputs: SessionInputQueue;
	readonly retry: SessionRetry;
	readonly boundaries: SessionBoundaries;
	readonly toolCalls: SessionToolCalls;
	/** The session's `_emitExtensionEvent`. */
	emitExtensionEvent(event: AgentEvent): Promise<void>;
}

/** Internal handler for agent events - shared by subscribe and reconnect */
export async function handleAgentEvent(host: AgentEventsHost, event: AgentEvent): Promise<void> {
	const { session, run } = host;
	// An abort requested while the run was starting, e.g. during before_agent_start, stops it
	// here. agent_start is awaited before the first request.
	if (event.type === "agent_start" && run.agentRunAbortRequested) session.agent.abort();
	// Record the calls a tool made through ctx.executeTool() and their usage on its result message.
	host.toolCalls.recordNestedCalls(event);
	// When a user message starts, check if it's from either queue and remove it BEFORE emitting
	// This ensures the UI sees the updated queue state
	if (event.type === "message_start" && event.message.role === "user") {
		run.overflowRecoveryAttempted = false;
		host.inputs.consumeQueuedUserMessage(event.message);
	}

	// Emit to extensions first, then notify public listeners.
	await host.emitExtensionEvent(event);
	host.emit(event.type === "agent_end" ? { ...event, willRetry: host.retry.willRetryAfterAgentEnd(event) } : event);

	// Handle session persistence
	if (event.type === "message_end") {
		// Before the append, which can throw: the run's outcome must not depend on the disk.
		if (event.message.role === "assistant") recordRunMessage(run.outcome, event.message);
		let entryId: string | undefined;
		// Check if this is a custom message from extensions
		if (event.message.role === "custom") {
			// Persist as CustomMessageEntry
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
			entryId = session.sessionManager.appendMessage(event.message);
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
	// extension and listener dispatch above also picks up messages that turn_end
	// handlers queued.
	if (event.type === "turn_end") {
		host.inputs.flushDuringRun(run.outcome);
	}
}

/** Emit extension events based on agent events */
export async function emitExtensionEvent(
	host: Pick<AgentEventsHost, "session" | "run" | "boundaries">,
	event: AgentEvent,
): Promise<void> {
	const { session, run } = host;
	if (event.type === "agent_start") {
		run.turnIndex = 0;
		await session.extensionRunner.emit({ type: "agent_start" });
	} else if (event.type === "agent_end") {
		await session.extensionRunner.emit({
			type: "agent_end",
			messages: event.messages,
		});
	} else if (event.type === "turn_start") {
		const extensionEvent: TurnStartEvent = {
			type: "turn_start",
			turnIndex: run.turnIndex,
			timestamp: Date.now(),
		};
		await session.extensionRunner.emit(extensionEvent);
	} else if (event.type === "turn_end") {
		if (event.message.role === "assistant" && !host.boundaries.takeDispatched(event.message)) {
			await host.boundaries.dispatchTurnEnd(event.message, event.toolResults);
		}
		run.turnIndex++;
	} else if (event.type === "message_start") {
		const extensionEvent: MessageStartEvent = {
			type: "message_start",
			message: event.message,
		};
		await session.extensionRunner.emit(extensionEvent);
	} else if (event.type === "message_update") {
		const extensionEvent: MessageUpdateEvent = {
			type: "message_update",
			message: event.message,
			assistantMessageEvent: event.assistantMessageEvent,
		};
		await session.extensionRunner.emit(extensionEvent);
	} else if (event.type === "message_end") {
		const extensionEvent: MessageEndEvent = {
			type: "message_end",
			message: event.message,
		};
		const replacement = await session.extensionRunner.emitMessageEnd(extensionEvent);
		if (replacement) {
			// Untyped extension handlers can return messages with null/missing content;
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
		const extensionEvent: ToolExecutionStartEvent = {
			type: "tool_execution_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		};
		await session.extensionRunner.emit(extensionEvent);
	} else if (event.type === "tool_execution_update") {
		const extensionEvent: ToolExecutionUpdateEvent = {
			type: "tool_execution_update",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			partialResult: event.partialResult,
		};
		await session.extensionRunner.emit(extensionEvent);
	} else if (event.type === "tool_execution_end") {
		const extensionEvent: ToolExecutionEndEvent = {
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
			...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
		};
		await session.extensionRunner.emit(extensionEvent);
	}
}
