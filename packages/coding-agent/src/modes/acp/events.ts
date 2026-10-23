import type { SessionNotification, StopReason, ToolCallContent } from "@agentclientprotocol/sdk";
import type { JsonAgentSessionEvent } from "../json-event.ts";

type Update = SessionNotification["update"];
const MAX_TOOL_TEXT = 16_000;
const TRUNCATED = "\n[Tool output truncated for ACP.]";

function chunk(text: string): Update[] {
	return text ? [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }] : [];
}

/** Only project visible textual content; details, raw output and binary payloads never cross this adapter. */
function toolContent(result: unknown): ToolCallContent[] {
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return [];
	let text = "";
	for (const block of result.content) {
		if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") continue;
		const separator = text ? "\n" : "";
		const remaining = MAX_TOOL_TEXT - text.length;
		text += (separator + block.text).slice(0, remaining + 1);
		if (text.length > MAX_TOOL_TEXT) {
			text = text.slice(0, MAX_TOOL_TEXT - TRUNCATED.length) + TRUNCATED;
			break;
		}
	}
	return text ? [{ type: "content", content: { type: "text", text } }] : [];
}

/** Stateful projection for one prompt. The broker owns session IDs, delivery order and settled completion. */
export class AcpEventProjector {
	private readonly streamed = new Map<number, string>();
	private readonly tools = new Set<string>();
	private reason: StopReason = "end_turn";
	private failure: string | undefined;

	get stopReason(): StopReason {
		return this.reason;
	}

	get error(): string | undefined {
		return this.failure;
	}

	update(event: JsonAgentSessionEvent): Update[] {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") this.streamed.clear();
				return [];
			case "message_update": {
				const delta = event.assistantMessageEvent;
				if (delta.type !== "text_delta") return [];
				this.streamed.set(delta.contentIndex, (this.streamed.get(delta.contentIndex) ?? "") + delta.delta);
				return chunk(delta.delta);
			}
			case "message_end": {
				const message = event.message;
				if (message.role !== "assistant") return [];
				const updates: Update[] = [];
				for (const [index, block] of message.content.entries()) {
					if (block.type !== "text") continue;
					const sent = this.streamed.get(index) ?? "";
					// ACP chunks cannot retract text. A divergent final snapshot must not duplicate the streamed response.
					if (block.text.startsWith(sent)) updates.push(...chunk(block.text.slice(sent.length)));
					this.streamed.set(index, block.text);
				}
				this.reason =
					message.stopReason === "length" ? "max_tokens" : message.stopReason === "aborted" ? "cancelled" : "end_turn";
				this.failure =
					message.stopReason === "error" ? message.errorMessage || "Assistant generation failed." : undefined;
				return updates;
			}
			case "agent_end":
				if (event.willRetry) {
					this.failure = undefined;
					this.reason = "end_turn";
				}
				return [];
			case "auto_retry_end":
				if (!event.success && event.finalError) this.failure = event.finalError;
				return [];
			case "tool_execution_start":
				return this.startTool(event.toolCallId, event.toolName);
			case "tool_execution_update":
				return [
					...this.startTool(event.toolCallId, event.toolName),
					{
						sessionUpdate: "tool_call_update",
						toolCallId: event.toolCallId,
						status: "in_progress",
						content: toolContent(event.partialResult),
					},
				];
			case "tool_execution_end":
				return [
					...this.startTool(event.toolCallId, event.toolName),
					{
						sessionUpdate: "tool_call_update",
						toolCallId: event.toolCallId,
						status: event.isError ? "failed" : "completed",
						content: toolContent(event.result),
					},
				];
			default:
				return [];
		}
	}

	private startTool(id: string, name: string): Update[] {
		if (this.tools.has(id)) return [];
		this.tools.add(id);
		return [{ sessionUpdate: "tool_call", toolCallId: id, title: name.slice(0, 512), status: "in_progress" }];
	}
}
