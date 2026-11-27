import type { AssistantContent, AssistantMessage } from "../../types.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { outputFields, providerOutputText } from "../provider-output.ts";
import { bedrockAnnotation, type CitationsDelta } from "./rich-content.ts";

interface RawEvent {
	contentBlockStart?: {
		contentBlockIndex: number;
		start?: {
			image?: { format?: string };
			toolResult?: Record<string, unknown>;
		};
	};
	contentBlockDelta?: {
		contentBlockIndex: number;
		delta?: {
			citation?: CitationsDelta;
			image?: { source?: { bytes?: string } };
			toolResult?: { text?: string; json?: unknown }[];
		};
	};
}

export function bedrockRichEvents() {
	const native = new Map<number, { block: AssistantContent; chunks: Uint8Array[] }>();
	return {
		isNative(id: string) {
			return native.has(Number(id));
		},
		handledError(error: unknown) {
			if (!(error instanceof Error) || error.name !== "AI_TypeValidationError" || !("value" in error)) return false;
			const event = error.value as RawEvent;
			const delta = event?.contentBlockDelta;
			if (!delta || !native.has(delta.contentBlockIndex) || !delta.delta || Object.keys(delta.delta).length !== 1)
				return false;
			if (delta.delta.image) return typeof delta.delta.image.source?.bytes === "string";
			return (
				Array.isArray(delta.delta.toolResult) &&
				delta.delta.toolResult.every(
					(part) =>
						part !== null && typeof part === "object" && (typeof part.text === "string" || part.json !== undefined),
				)
			);
		},
		accept(value: unknown, output: AssistantMessage, stream: AssistantMessageEventStream) {
			const event = value as RawEvent;
			const start = event.contentBlockStart;
			if (start?.start?.image || start?.start?.toolResult) {
				const block: AssistantContent = start.start.image
					? { type: "image", mimeType: `image/${start.start.image.format ?? "png"}`, data: "" }
					: providerOutputText("toolResult", outputFields(start.start.toolResult!, ["toolUseId", "type", "status"]));
				native.set(start.contentBlockIndex, { block, chunks: [] });
				output.content.push(block);
			}
			const delta = event.contentBlockDelta?.delta;
			if (delta?.citation) {
				const text = output.content.findLast((block) => block.type === "text");
				if (text?.type === "text") (text.annotations ??= []).push(bedrockAnnotation(delta.citation));
			}
			const state = native.get(event.contentBlockDelta?.contentBlockIndex ?? -1);
			if (state?.block.type === "image" && delta?.image?.source?.bytes) {
				state.chunks.push(Buffer.from(delta.image.source.bytes, "base64"));
				state.block.data = Buffer.concat(state.chunks).toString("base64");
			}
			if (state?.block.type === "text" && delta?.toolResult) {
				for (const part of delta.toolResult)
					state.block.text += part.text ?? `\n${providerOutputText("toolResult", { result: part.json }).text}`;
			}
			if (start || delta?.citation || state)
				stream.push({
					type: "content_update",
					contentIndex: state ? output.content.indexOf(state.block) : output.content.length - 1,
					partial: output,
				});
		},
	};
}
