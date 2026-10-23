import { randomUUID } from "node:crypto";
import type { ApplicationEvent, ApplicationMessage } from "@octocodeai/octocode-contacts";
import { toolHint } from "../../../octocode/shared/util.ts";
import type { AgentSessionEvent } from "../../agent-session.ts";
import { messageContentText, trimOldest } from "./projection.ts";

type SessionEventOf<T extends AgentSessionEvent["type"]> = Extract<AgentSessionEvent, { type: T }>;

/** What projecting session messages needs of the application service. */
export interface MessageProjectionHost {
	readonly messages: Map<string, ApplicationMessage>;
	readonly messageIds: WeakMap<object, string>;
	getActiveMessage(): string | undefined;
	setActiveMessage(id: string | undefined): void;
	/** Next `order` for a message seen for the first time. */
	nextOrder(): number;
	projectedOutput(owner: string, value: unknown): string | undefined;
	publishDomain(event: ApplicationEvent): void;
}

export function projectMessage(
	host: MessageProjectionHost,
	event: SessionEventOf<"message_start" | "message_end">,
): void {
	const id =
		host.messageIds.get(event.message) ??
		(event.message.role === "assistant" ? host.getActiveMessage() : undefined) ??
		randomUUID();
	host.messageIds.set(event.message, id);
	const content = "content" in event.message ? event.message.content : undefined;
	const owner =
		event.message.role === "toolResult"
			? event.message.toolName
			: event.message.role === "custom"
				? event.message.customType
				: undefined;
	const projected = owner ? host.projectedOutput(owner, event.message) : undefined;
	const text = projected ?? messageContentText(content);
	const message = {
		id,
		role: event.message.role,
		text: text.slice(-64000),
		complete: event.type === "message_end",
		order: host.messages.get(id)?.order ?? host.nextOrder(),
	};
	host.messages.set(id, message);
	if (message.role === "assistant") host.setActiveMessage(message.complete ? undefined : id);
	trimOldest(host.messages, 50, 131072);
	host.publishDomain({
		type: message.complete ? "message.completed" : "message.started",
		message,
	});
}

export function projectMessageUpdate(host: MessageProjectionHost, event: SessionEventOf<"message_update">): void {
	const update = event.assistantMessageEvent;
	if (update.type !== "text_delta") return;
	let id = host.messageIds.get(event.message) ?? host.getActiveMessage();
	if (!id) {
		id = randomUUID();
		host.setActiveMessage(id);
	}
	host.messageIds.set(event.message, id);
	let message = host.messages.get(id);
	if (!message) {
		message = {
			id,
			role: "assistant",
			text: "",
			complete: false,
			order: host.nextOrder(),
		};
		host.messages.set(id, message);
		host.publishDomain({ type: "message.started", message });
	}
	host.messages.set(id, {
		...message,
		text: (message.text + update.delta).slice(-64000),
	});
	host.publishDomain({
		type: "message.delta",
		messageId: id,
		delta: update.delta.slice(-64000),
		text: host.messages.get(id)!.text,
	});
}

/** The domain event for a tool execution event; `outputText` renders the partial or final result. */
export function toolDomainEvent(
	event: SessionEventOf<"tool_execution_start" | "tool_execution_update" | "tool_execution_end">,
	outputText: (owner: string, value: unknown) => string,
): ApplicationEvent {
	// A redacted one-line label from the arguments; later frames replace `text` with output, the hint stays.
	const hint = event.type === "tool_execution_start" ? toolHint(event.args) : "";
	return {
		type:
			event.type === "tool_execution_start"
				? "tool.started"
				: event.type === "tool_execution_update"
					? "tool.progress"
					: "tool.completed",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		...(hint ? { hint } : {}),
		...(event.type === "tool_execution_end"
			? { failed: event.isError, text: outputText(event.toolName, event.result) }
			: event.type === "tool_execution_update"
				? { text: outputText(event.toolName, event.partialResult) }
				: {}),
	};
}
