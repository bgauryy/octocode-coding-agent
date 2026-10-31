// Internal import for JSON parsing utility
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantContent,
	type ContentAnnotation,
	parseStreamingJsonThrottled,
	type StopReason,
	type ToolCall,
} from "@octocodeai/octocode-ai";

/**
 * Proxy event types - server sends these with partial field stripped to reduce bandwidth.
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| {
			type: "text_end";
			contentIndex: number;
			contentSignature?: string;
			text?: string;
			annotations?: ContentAnnotation[];
	  }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| { type: "content_update"; contentIndex: number; content: AssistantContent }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
			providerThinkingLevel?: string;
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
			providerThinkingLevel?: string;
	  };

/** A tool call still streaming: its raw JSON accumulates beside the parsed arguments until `toolcall_end`. */
type StreamingToolCall = ToolCall & { partialJson?: string };

type ContentOf<Kind extends AssistantContent["type"]> = Extract<AssistantContent, { type: Kind }>;

/** The partial's content at `index` when it has the kind this event extends; anything else is a protocol violation. */
function expectContent<Kind extends AssistantContent["type"]>(
	partial: AssistantMessage,
	index: number,
	kind: Kind,
	eventType: string,
): ContentOf<Kind> {
	const content = partial.content[index];
	if (content?.type !== kind) throw new Error(`Received ${eventType} for non-${kind} content`);
	return content as ContentOf<Kind>;
}

/** Record how the response ended; the proxy sends the final usage and thinking level with both `done` and `error`. */
function settlePartial(
	partial: AssistantMessage,
	end: { reason: StopReason; usage: AssistantMessage["usage"]; providerThinkingLevel?: string },
): void {
	partial.stopReason = end.reason;
	partial.usage = end.usage;
	if (end.providerThinkingLevel !== undefined) partial.providerThinkingLevel = end.providerThinkingLevel;
}

/** End the partial as failed without a server event (dropped connection, abort, transport error) and return the error event. */
export function failProxyStream(
	partial: AssistantMessage,
	reason: Extract<StopReason, "aborted" | "error">,
	errorMessage: string,
): AssistantMessageEvent {
	partial.stopReason = reason;
	partial.errorMessage = errorMessage;
	return { type: "error", reason, error: partial };
}

/**
 * Process a proxy event and update the partial message.
 * An event that extends content of the wrong kind throws, so the stream ends as an error.
 */
export function processProxyEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "start":
			return { type: "start", partial };
		case "content_update":
			partial.content[proxyEvent.contentIndex] = proxyEvent.content;
			return { type: "content_update", contentIndex: proxyEvent.contentIndex, partial };

		case "text_start":
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

		case "text_delta": {
			const content = expectContent(partial, proxyEvent.contentIndex, "text", "text_delta");
			content.text += proxyEvent.delta;
			return { type: "text_delta", contentIndex: proxyEvent.contentIndex, delta: proxyEvent.delta, partial };
		}

		case "text_end": {
			const content = expectContent(partial, proxyEvent.contentIndex, "text", "text_end");
			content.textSignature = proxyEvent.contentSignature;
			if (proxyEvent.text !== undefined) content.text = proxyEvent.text;
			if (proxyEvent.annotations !== undefined) content.annotations = proxyEvent.annotations;
			return { type: "text_end", contentIndex: proxyEvent.contentIndex, content: content.text, partial };
		}

		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

		case "thinking_delta": {
			const content = expectContent(partial, proxyEvent.contentIndex, "thinking", "thinking_delta");
			content.thinking += proxyEvent.delta;
			return { type: "thinking_delta", contentIndex: proxyEvent.contentIndex, delta: proxyEvent.delta, partial };
		}

		case "thinking_end": {
			const content = expectContent(partial, proxyEvent.contentIndex, "thinking", "thinking_end");
			content.thinkingSignature = proxyEvent.contentSignature;
			return { type: "thinking_end", contentIndex: proxyEvent.contentIndex, content: content.thinking, partial };
		}

		case "toolcall_start": {
			const call: StreamingToolCall = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				partialJson: "",
			};
			partial.content[proxyEvent.contentIndex] = call;
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };
		}

		case "toolcall_delta": {
			const content = expectContent(partial, proxyEvent.contentIndex, "toolCall", "toolcall_delta");
			const call: StreamingToolCall = content;
			call.partialJson = (call.partialJson ?? "") + proxyEvent.delta;
			content.arguments = parseStreamingJsonThrottled(content.arguments, call.partialJson);
			partial.content[proxyEvent.contentIndex] = { ...content }; // Trigger reactivity
			return { type: "toolcall_delta", contentIndex: proxyEvent.contentIndex, delta: proxyEvent.delta, partial };
		}

		case "toolcall_end": {
			const content = expectContent(partial, proxyEvent.contentIndex, "toolCall", "toolcall_end");
			Object.assign(content, proxyEvent.toolCall);
			const call: StreamingToolCall = content;
			delete call.partialJson;
			return { type: "toolcall_end", contentIndex: proxyEvent.contentIndex, toolCall: content, partial };
		}

		case "done":
			settlePartial(partial, proxyEvent);
			return { type: "done", reason: proxyEvent.reason, message: partial };

		case "error":
			settlePartial(partial, proxyEvent);
			partial.errorMessage = proxyEvent.errorMessage;
			return { type: "error", reason: proxyEvent.reason, error: partial };

		default: {
			const _exhaustiveCheck: never = proxyEvent;
			console.warn(`Unhandled proxy event type: ${(proxyEvent as { type: string }).type}`);
			return undefined;
		}
	}
}
