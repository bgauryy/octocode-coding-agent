/** Tool call and tool result events with their type guards. */

import type { ImageContent, JsonValue, TextContent, Usage } from "@octocodeai/octocode-ai";
import type { BashToolDetails, BashToolInput } from "../../tools/index.ts";

// ============================================================================
// Tool Events
// ============================================================================

interface ToolCallEventBase {
	type: "tool_call";
	/**
	 * The call's id. For calls another tool made (with `parentToolCallId` set), pi assigns
	 * `<parent id>/<n>`; such ids never appear as tool calls or tool results in the transcript, only
	 * in the parent result's `nestedCalls` record.
	 */
	toolCallId: string;
	/** Set when another tool (for example another tool) issued this call. */
	parentToolCallId?: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
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

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

/** Fired after a tool executes. Can modify result. */
export type ToolResultEvent = BashToolResultEvent | CustomToolResultEvent;

// Type guards for ToolResultEvent
export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
	return e.toolName === "bash";
}

/**
 * Type guard for narrowing ToolCallEvent by tool name.
 *
 * Built-in tools narrow automatically (no type params needed):
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * Custom tools require explicit type parameters:
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // typed
 * }
 * ```
 *
 * Note: Direct narrowing via `event.toolName === "bash"` doesn't work because
 * CustomToolCallEvent.toolName is `string` which overlaps with all literals.
 */
export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	toolName: TName,
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}
