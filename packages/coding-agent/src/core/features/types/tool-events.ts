/** Tool call and tool result events with their type guards. */

import type { ImageContent, JsonValue, TextContent, Usage } from "@octocodeai/octocode-ai";
import type { BashToolDetails } from "../../tools/bash/outcome.ts";
import type { BashToolInput } from "../../tools/bash/schema.ts";

// Tool Events
// ============================================================================

interface ToolCallEventBase {
	type: "tool_call";
	/**
	 * The call's id. For calls another tool made (with `parentToolCallId` set), Octocode assigns
	 * `<parent id>/<n>`; such ids never appear as tool calls or tool results in the transcript, only
	 * in the parent result's `nestedCalls` record.
	 */
	toolCallId: string;
	/** Who issued the call. Omitted by older feature callers; treat omission as a model call. */
	origin?: "model" | "tool" | "user" | "hook";
	/** Set when another tool (for example another tool) issued this call. */
	parentToolCallId?: string;
	/** Set while the call starts before its assistant message ended (`toolExecution.earlyStart`): no dialog may open; answer `defer` instead. */
	early?: true;
}

interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

/**
 * Fired before a tool executes. Can block.
 *
 * `event.input` is mutable. Mutate it in place to patch tool arguments before execution.
 * Later `tool_call` handlers see earlier mutations. No re-validation is performed after mutation.
 */
export type ToolCallEvent = BashToolCallEvent | CustomToolCallEvent;

interface ToolResultEventBase {
	type: "tool_result";
	/** The call's id; `<parent id>/<n>` for nested calls, see `ToolCallEvent`. */
	toolCallId: string;
	/** Set when another tool (for example another tool) issued this call. */
	parentToolCallId?: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	/**
	 * Machine-readable result for tools that declare an `outputSchema`. Handlers that redact
	 * `content` should also replace this; replacing `content` alone drops it.
	 */
	structuredContent?: JsonValue;
	isError: boolean;
	/** Usage from the tool execution itself, if available. */
	usage?: Usage;
}

interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

/** Fired after a tool executes. Can modify result. */
export type ToolResultEvent = BashToolResultEvent | CustomToolResultEvent;
