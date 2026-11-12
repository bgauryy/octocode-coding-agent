import type { AgentSessionEvent } from "../core/agent-session.ts";
import { type JsonAgentSessionEvent, toJsonEvent } from "./json-event.ts";

/**
 * Lean RPC events (`--rpc-lean-events`): each message and tool result travels whole once, and every later event that
 * repeats it carries a reference. The default events repeat a tool result up to five times (`message_start`,
 * `message_end`, `tool_execution_end`, `turn_end`, `agent_end`), with a bash result's 1 MiB `structuredContent` and every
 * assistant message's `requestTrace` each time; a subagent's parent reads none of those copies.
 *
 * | Event | Lean form |
 * | --- | --- |
 * | `tool_execution_end` | the result without `structuredContent` (the data for programmatic callers) |
 * | `message_start`, `message_end` of a tool result | the message without `content`, `details` and `structuredContent`: `tool_execution_end` of its `toolCallId` carried them |
 * | `message_end` of an assistant message | the message without `requestTrace` |
 * | `turn_end`, `agent_end` | each message as a reference: `role`, `timestamp`, and `toolCallId`, `toolName`, `isError` or `stopReason` when it has them |
 *
 * Every other event, and user and custom messages, are the default ones.
 */

type Record_ = Record<string, unknown>;

const isRecord = (value: unknown): value is Record_ =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const REFERENCE_FIELDS = ["role", "timestamp", "toolCallId", "toolName", "isError", "stopReason"] as const;

function without(record: Record_, keys: readonly string[]): Record_ {
	const copy: Record_ = {};
	for (const key of Object.keys(record)) if (!keys.includes(key)) copy[key] = record[key];
	return copy;
}

/** A message as `turn_end` and `agent_end` refer to it. */
function reference(message: unknown): unknown {
	if (!isRecord(message)) return message;
	const ref: Record_ = {};
	for (const key of REFERENCE_FIELDS) if (message[key] !== undefined) ref[key] = message[key];
	return ref;
}

/** A message as `message_start` and `message_end` carry it in lean events. */
function leanMessage(message: unknown): unknown {
	if (!isRecord(message)) return message;
	if (message.role === "toolResult") return without(message, ["content", "details", "structuredContent"]);
	if (message.role === "assistant" && "requestTrace" in message) return without(message, ["requestTrace"]);
	return message;
}

export function toLeanJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent | Record_ {
	const json = toJsonEvent(event) as JsonAgentSessionEvent & Record_;
	switch (json.type) {
		case "message_start":
		case "message_end":
			return { ...json, message: leanMessage(json.message) };
		case "tool_execution_end":
			return isRecord(json.result) && "structuredContent" in json.result
				? { ...json, result: without(json.result, ["structuredContent"]) }
				: json;
		case "turn_end":
			return {
				...json,
				message: reference(json.message),
				toolResults: Array.isArray(json.toolResults) ? json.toolResults.map(reference) : json.toolResults,
			};
		case "agent_end":
			return { ...json, messages: Array.isArray(json.messages) ? json.messages.map(reference) : json.messages };
		default:
			return json;
	}
}
