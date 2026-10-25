import type { AgentSessionEvent } from "../../agent-session.ts";
import type { SessionEntry } from "../../session-manager.ts";
import { record } from "../normalize.ts";

/** Every native event has an explicit portable owner; new event kinds require a routing decision. */
export const APPLICATION_EVENT_ROUTES = {
	agent_start: "run",
	agent_end: "activity",
	agent_settled: "run",
	session_dispatch: "dispatch",
	turn_start: "activity",
	turn_end: "activity",
	message_start: "message",
	message_update: "message",
	message_end: "message",
	tool_execution_start: "tool",
	tool_execution_update: "tool",
	tool_execution_end: "tool",
	queue_update: "queue",
	compaction_start: "status+activity",
	compaction_end: "status+activity",
	entry_appended: "activity",
	session_info_changed: "activity",
	session_context_changed: "reset",
	thinking_level_changed: "activity",
	auto_retry_start: "status+activity",
	auto_retry_end: "status+activity",
	summarization_retry_scheduled: "activity",
	summarization_retry_attempt_start: "activity",
	summarization_retry_finished: "activity",
	bash_execution_update: "activity",
} satisfies Record<AgentSessionEvent["type"], string>;

export interface ActivityData {
	kind: string;
	text: string;
	data?: unknown;
}
function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
	const source = record(value);
	return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}
function usage(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	const data = pick(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]);
	if (record(value).cost !== undefined)
		data.cost = pick(record(value).cost, ["input", "output", "cacheRead", "cacheWrite", "total"]);
	return data;
}
function summary(value: unknown): Record<string, unknown> {
	return {
		...pick(value, ["summary", "firstKeptEntryId", "fromId", "tokensBefore", "estimatedTokensAfter", "fromHook"]),
		usage: usage(record(value).usage),
		...(record(value).details !== undefined ? { privateDetailsStored: true } : {}),
	};
}
/** Session entries mix public metadata with private state. Only the declared display fields cross this boundary. */
export function entryActivity(entry: SessionEntry): ActivityData | undefined {
	switch (entry.type) {
		case "message":
		case "custom_message":
			return undefined;
		case "usage":
			return {
				kind: "usage",
				text: `${entry.kind} usage${entry.note ? `: ${entry.note}` : ""}`,
				data: { ...pick(entry, ["kind", "cacheRequestedAt", "provider", "model", "note"]), usage: usage(entry.usage) },
			};
		case "thinking_level_change":
			return { kind: entry.type, text: `Thinking level: ${entry.thinkingLevel}`, data: { level: entry.thinkingLevel } };
		case "model_change":
			return {
				kind: entry.type,
				text: `Model: ${entry.provider}/${entry.modelId}`,
				data: pick(entry, ["provider", "modelId"]),
			};
		case "session_info":
			return {
				kind: entry.type,
				text: entry.name ? `Session: ${entry.name}` : "Session name cleared",
				data: pick(entry, ["name"]),
			};
		case "label":
			return {
				kind: entry.type,
				text: entry.label ? `Label: ${entry.label}` : "Label removed",
				data: pick(entry, ["targetId", "label"]),
			};
		case "context_edit":
			return {
				kind: entry.type,
				text: entry.replacement === null ? "Context entry omitted" : "Context entry replaced",
				data: { targetId: entry.targetId, operation: entry.replacement === null ? "omit" : "replace" },
			};
		case "custom":
			return {
				kind: entry.type,
				text: `Extension state: ${entry.customType}`,
				data: { customType: entry.customType, privateDataStored: entry.data !== undefined },
			};
		case "compaction":
			return { kind: entry.type, text: "Context compacted", data: summary(entry) };
		case "branch_summary":
			return { kind: entry.type, text: "Branch summarized", data: summary(entry) };
	}
}

export function nativeActivity(event: AgentSessionEvent): ActivityData | undefined {
	switch (event.type) {
		case "turn_start":
			return { kind: event.type, text: "Turn started" };
		case "turn_end":
			return {
				kind: event.type,
				text: "Turn ended",
				data: {
					role: event.message.role,
					stopReason: record(event.message).stopReason,
					toolResultCount: event.toolResults.length,
					failedToolCount: event.toolResults.filter((result) => result.isError).length,
				},
			};
		case "agent_end":
			return {
				kind: event.type,
				text: event.willRetry ? "Agent attempt ended; retry pending" : "Agent attempt ended",
				data: { messageCount: event.messages.length, willRetry: event.willRetry },
			};
		case "session_info_changed":
			return {
				kind: event.type,
				text: event.name ? `Session: ${event.name}` : "Session name cleared",
				data: pick(event, ["name"]),
			};
		case "thinking_level_changed":
			return { kind: event.type, text: `Thinking level: ${event.level}`, data: { level: event.level } };
		case "compaction_start":
			return { kind: event.type, text: "Compaction started", data: { reason: event.reason } };
		case "compaction_end":
			return {
				kind: event.type,
				text: event.aborted ? "Compaction aborted" : event.errorMessage ? "Compaction failed" : "Compaction finished",
				data: {
					...pick(event, ["reason", "aborted", "willRetry", "errorMessage"]),
					...(event.result ? { result: summary(event.result) } : {}),
				},
			};
		case "auto_retry_start":
		case "summarization_retry_scheduled":
			return {
				kind: event.type,
				text: `Retry ${event.attempt}/${event.maxAttempts} scheduled`,
				data: pick(event, ["attempt", "maxAttempts", "delayMs", "errorMessage"]),
			};
		case "auto_retry_end":
			return {
				kind: event.type,
				text: event.success ? "Retry succeeded" : "Retry failed",
				data: pick(event, ["success", "attempt", "finalError"]),
			};
		case "summarization_retry_attempt_start":
			return { kind: event.type, text: "Summary retry started", data: pick(event, ["source", "reason"]) };
		case "summarization_retry_finished":
			return { kind: event.type, text: "Summary retry finished" };
		default:
			return undefined;
	}
}
