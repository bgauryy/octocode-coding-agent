import type { ResponseOutputItem, ResponseStreamEvent } from "../ai-sdk/openai-wire-types.ts";
import type { AssistantContent, AssistantMessage, MediaContent, TextContent } from "../../types.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { responseArtifact } from "./rich-content.ts";

/** Keeps streamed and terminal copies of provider artifacts in the same ordered content slot. */
export class ResponsesArtifacts {
	private readonly indices = new Map<string, number>();
	private readonly output: AssistantMessage;
	private readonly stream: AssistantMessageEventStream;
	private audio: MediaContent | undefined;
	private transcript: TextContent | undefined;

	constructor(output: AssistantMessage, stream: AssistantMessageEventStream) {
		this.output = output;
		this.stream = stream;
	}

	private update(key: string, block: AssistantContent): number {
		const index = this.indices.get(key) ?? this.output.content.length;
		this.indices.set(key, index);
		this.output.content[index] = block;
		this.stream.push({ type: "content_update", contentIndex: index, partial: this.output });
		return index;
	}

	upsert(item: ResponseOutputItem, outputIndex: number): number {
		return this.update("id" in item && item.id ? `item:${item.id}` : `output:${outputIndex}`, responseArtifact(item));
	}

	finish(items: ResponseOutputItem[]): void {
		for (const [index, item] of items.entries()) {
			if (["reasoning", "message", "function_call", "custom_tool_call"].includes(item.type)) continue;
			this.upsert(item, index);
		}
	}

	accept(event: ResponseStreamEvent): boolean {
		if (event.type === "response.image_generation_call.partial_image") {
			this.update(`item:${event.item_id}`, {
				type: "image",
				data: event.partial_image_b64,
				mimeType: `image/${event.output_format ?? "png"}`,
			});
			return true;
		}
		if (event.type === "response.audio.delta") {
			// The event does not identify an audio codec. Preserve the bytes as a downloadable asset;
			// guessing a WAV/MP3 MIME type would make consumers misinterpret the original payload.
			this.audio ??= { type: "media", mimeType: "application/octet-stream", name: "Response audio", data: "" };
			this.audio.data = btoa(atob(this.audio.data ?? "") + atob(event.delta));
			this.update("audio", this.audio);
			return true;
		}
		if (event.type === "response.audio.transcript.delta") {
			this.transcript ??= { type: "text", text: "" };
			this.transcript.text += event.delta;
			this.update("audio-transcript", this.transcript);
			return true;
		}
		return event.type === "response.audio.done" || event.type === "response.audio.transcript.done";
	}
}
