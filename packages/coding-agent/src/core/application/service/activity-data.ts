import type { AgentSessionEvent } from "../../agent-session/types.ts";
import { compactionSummaryDisplay } from "../../messages.ts";
import type { SessionEntry } from "../../session-manager.ts";
import { asRecord } from "@octocodeai/octocode-contracts/guards";

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
	// Once a second while a summary streams: the status line shows it; the activity log would only repeat it.
	compaction_progress: "status",
	// Refreshed every few seconds while a request is quiet: the status line shows it; the activity log would only repeat it.
	model_wait: "status",
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
	/** The activity reports a failure; clients show it as one. */
	failed?: boolean;
}
function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
	const source = asRecord(value);
	return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}
function usage(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	const data = pick(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]);
	if (asRecord(value).cost !== undefined)
		data.cost = pick(asRecord(value).cost, ["input", "output", "cacheRead", "cacheWrite", "total"]);
	return data;
}
function summary(value: unknown): Record<string, unknown> {
	return {
		...pick(value, ["summary", "firstKeptEntryId", "fromId", "tokensBefore", "estimatedTokensAfter", "fromHook"]),
		usage: usage(asRecord(value).usage),
		...(asRecord(value).details !== undefined ? { privateDetailsStored: true } : {}),
	};
}
/** A compaction's data with its summary as a person reads it, not as written for the model. */
function compaction(value: unknown): Record<string, unknown> {
	const { summary: text, tokensBefore } = asRecord(value);
	return {
		...summary(value),
		...(typeof text === "string"
			? {
					summary: compactionSummaryDisplay({
						summary: text,
						tokensBefore: typeof tokensBefore === "number" ? tokensBefore : 0,
					}),
				}
			: {}),
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
		case "custom": {
			// Octocode records a refused or cancelled compaction as a note (`octocode/compaction/record.ts`); it is a failure.
			const note = asRecord(entry.data);
			if (
				entry.customType === "octocode-compaction-note" &&
				(note.kind === "thrash-stop" || note.kind === "checkpoint-not-saved") &&
				typeof note.reason === "string"
			)
				return {
					kind: entry.type,
					text: note.reason,
					data: { customType: entry.customType, kind: note.kind },
					failed: true,
				};
			// One backlog state change (`octocode/backlog/status-line.ts`): its line is the whole content.
			if (entry.customType === "octocode-backlog-line" && typeof note.text === "string" && note.text.trim())
				return {
					kind: entry.type,
					text: note.text,
					data: { customType: entry.customType, ...pick(note, ["ref", "change"]) },
				};
			return {
				kind: entry.type,
				text: `Feature state: ${entry.customType}`,
				data: { customType: entry.customType, privateDataStored: entry.data !== undefined },
			};
		}
		case "compaction":
			return { kind: entry.type, text: "Context compacted", data: compaction(entry) };
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
					stopReason: asRecord(event.message).stopReason,
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
				text: event.aborted ? "Compaction aborted" : event.errorMessage ? event.errorMessage : "Compaction finished",
				...(!event.aborted && event.errorMessage ? { failed: true } : {}),
				data: {
					...pick(event, ["reason", "aborted", "willRetry", "errorMessage"]),
					...(event.result ? { result: compaction(event.result) } : {}),
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
