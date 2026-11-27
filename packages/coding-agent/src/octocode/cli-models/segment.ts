import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	StopReason,
	TextContent,
	ToolCall,
	Usage,
} from "@octocodeai/octocode-ai";
import { createEmptyUsage } from "@octocodeai/octocode-ai/utils/assistant-message";

/**
 * One assistant message of a Claude Code turn, written to the agent loop's stream as it arrives: text deltas, then
 * either the tool calls Claude Code made (the loop runs them) or the end of its turn. `responseId` names the ACP session,
 * so a later request knows Claude Code saw everything up to here.
 */
export class Segment {
	readonly message: AssistantMessage;
	private readonly stream: AssistantMessageEventStream;
	private text?: { index: number; block: TextContent };
	private ended = false;

	constructor(stream: AssistantMessageEventStream, model: Model<string>) {
		this.stream = stream;
		this.message = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createEmptyUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: this.message });
	}

	get finished(): boolean {
		return this.ended;
	}

	delta(text: string): void {
		if (this.ended || !text) return;
		if (!this.text) {
			const block: TextContent = { type: "text", text: "" };
			this.text = { index: this.message.content.push(block) - 1, block };
			this.stream.push({ type: "text_start", contentIndex: this.text.index, partial: this.message });
		}
		this.text.block.text += text;
		this.stream.push({ type: "text_delta", contentIndex: this.text.index, delta: text, partial: this.message });
	}

	toolCall(call: ToolCall): void {
		if (this.ended) return;
		this.closeText();
		const index = this.message.content.push({ ...call, arguments: {} }) - 1;
		this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.message });
		this.message.content[index] = call;
		this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: this.message });
	}

	done(reason: Extract<StopReason, "stop" | "toolUse">, usage: Usage, responseId: string, raw?: string): void {
		if (this.ended) return;
		this.closeText();
		Object.assign(this.message, { usage, stopReason: reason, responseId, ...(raw ? { rawStopReason: raw } : {}) });
		this.finish({ type: "done", reason, message: this.message });
	}

	/** Ends the message as aborted or failed; `responseId` only when Claude Code had the prompt. */
	fail(reason: "aborted" | "error", errorMessage: string, responseId?: string): void {
		if (this.ended) return;
		this.closeText();
		Object.assign(this.message, { stopReason: reason, errorMessage, ...(responseId ? { responseId } : {}) });
		this.finish({ type: "error", reason, error: this.message });
	}

	private closeText(): void {
		if (!this.text) return;
		this.stream.push({
			type: "text_end",
			contentIndex: this.text.index,
			content: this.text.block.text,
			partial: this.message,
		});
		this.text = undefined;
	}

	private finish(event: Parameters<AssistantMessageEventStream["push"]>[0]): void {
		this.ended = true;
		this.stream.push(event);
		this.stream.end(this.message);
	}
}
