import type { ToolResultMessage } from "@octocodeai/octocode-ai";
import type { AgentEvent, AgentToolCall, AgentToolCallOutcome, AgentToolResult } from "../types.ts";
import { sinceMs, toolCallPhases } from "./tool-timing.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

export type ToolUpdateSink = (partialResult: AgentToolResult<any>) => Promise<void> | void;

export function emitToolExecutionUpdate(toolCall: AgentToolCall, emit: AgentEventSink): ToolUpdateSink {
	return (partialResult) =>
		emit({
			type: "tool_execution_update",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
			partialResult,
		});
}

/** When each call ended (`performance.now()`), so its result message can say how long the result was held. */
const endedAt = new WeakMap<AgentToolCallOutcome, number>();

export async function emitToolExecutionEnd(finalized: AgentToolCallOutcome, emit: AgentEventSink): Promise<void> {
	endedAt.set(finalized, performance.now());
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
		...(finalized.durationMs === undefined ? {} : { durationMs: finalized.durationMs }),
	});
}

export function createToolResultMessage(finalized: AgentToolCallOutcome): ToolResultMessage {
	const ended = endedAt.get(finalized);
	const phases = toolCallPhases({ ...finalized.phases, ...(ended === undefined ? {} : { heldMs: sinceMs(ended) }) });
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		...(finalized.result.structuredContent === undefined
			? {}
			: { structuredContent: finalized.result.structuredContent }),
		usage: finalized.result.usage,
		isError: finalized.isError,
		...(finalized.durationMs === undefined ? {} : { durationMs: finalized.durationMs }),
		...(phases ? { phases } : {}),
		timestamp: Date.now(),
	};
}

export async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
