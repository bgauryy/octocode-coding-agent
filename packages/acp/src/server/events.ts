import type { ImageContent, TextContent } from "@octocodeai/octocode-ai";
import type { SessionNotification, StopReason, ToolCallContent } from "@agentclientprotocol/sdk";
import type { RpcEvent } from "../../../coding-agent/src/modes/rpc/rpc-client.ts";

type Update = SessionNotification["update"];
const MAX_TOOL_TEXT = 16_000;
/** Kept from the start of an oversized result: bash's `[exit 1 · 4.2s · …]` status line and the output before the cut. */
const HEAD_TEXT = 4_000;
/** Room for the omission note, so the whole text stays within `MAX_TOOL_TEXT`. */
const NOTE_ROOM = 100;

function chunk(text: string): Update[] {
	return text ? [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }] : [];
}

/**
 * A displayed custom message (a subagent report, team mail, a hook or external notice) as agent-side content. Its text
 * comes from a child, a peer or an API client, never from the user, so it is not a `user_message_chunk`; `_meta` names
 * its custom type for clients that label it.
 */
export function customMessageUpdates(message: {
	customType: string;
	content: string | Array<TextContent | ImageContent>;
}): Update[] {
	const blocks =
		typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	const updates: Update[] = [];
	for (const block of blocks) {
		if (block.type === "text" && !block.text) continue;
		updates.push({
			sessionUpdate: "agent_message_chunk",
			content:
				block.type === "text"
					? { type: "text", text: block.text }
					: { type: "image", data: block.data, mimeType: block.mimeType },
			_meta: { "octocode/customType": message.customType },
		});
	}
	return updates;
}

/**
 * Only project visible textual content; details, raw output and binary payloads never cross this adapter. An oversized
 * result keeps its start and its end: a command's status line leads and its failure or summary comes last.
 */
export function toolContent(result: unknown): ToolCallContent[] {
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return [];
	const texts: string[] = [];
	for (const block of result.content) {
		if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") continue;
		texts.push(block.text);
	}
	let text = texts.join("\n");
	if (text.length > MAX_TOOL_TEXT) {
		const keep = MAX_TOOL_TEXT - NOTE_ROOM;
		const omitted = text.length - keep;
		text = `${text.slice(0, HEAD_TEXT)}\n[Tool output truncated for ACP: ${omitted} characters omitted.]\n${text.slice(text.length - (keep - HEAD_TEXT))}`;
	}
	return text ? [{ type: "content", content: { type: "text", text } }] : [];
}

/** Stateful projection for one prompt. The broker owns session IDs, delivery order and settled completion. */
export class AcpEventProjector {
	private readonly streamed = new Map<number, string>();
	private readonly tools = new Set<string>();
	private reason: StopReason = "end_turn";
	private failure: string | undefined;
	private commandFailure: string | undefined;

	get stopReason(): StopReason {
		return this.reason;
	}

	get error(): string | undefined {
		return this.commandFailure ?? this.failure;
	}

	update(event: RpcEvent): Update[] {
		switch (event.type) {
			case "extension_error":
				if (event.event === "command") this.commandFailure = event.error;
				return [];
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
				if (message.role === "custom") return message.display ? customMessageUpdates(message) : [];
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
