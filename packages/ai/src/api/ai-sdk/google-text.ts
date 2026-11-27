import type { AssistantMessage, TextContent, ThinkingContent } from "../../types.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { isThinkingPart, retainThoughtSignature } from "./google-signatures.ts";

import type { GooglePart as Part } from "./google-shapes.ts";
import { googleArtifact } from "./google-rich-content.ts";

export function googleTextParts() {
	let current: { block: TextContent | ThinkingContent; index: number } | undefined;
	const pending: { part: Part; index: number }[] = [];
	const end = (output: AssistantMessage, stream: AssistantMessageEventStream) => {
		if (!current) return;
		const { block, index } = current;
		stream.push(
			block.type === "text"
				? { type: "text_end", contentIndex: index, content: block.text, partial: output }
				: { type: "thinking_end", contentIndex: index, content: block.thinking, partial: output },
		);
		current = undefined;
	};
	const drain = (output: AssistantMessage, stream: AssistantMessageEventStream) => {
		while (pending.length && !pending[0].part.functionCall) {
			const { part, index } = pending.shift()!;
			const artifact = googleArtifact(part);
			if (artifact) {
				end(output, stream);
				output.content.push(artifact);
				stream.push({ type: "content_update", contentIndex: output.content.length - 1, partial: output });
				continue;
			}
			if (part.text === undefined && (!part.thoughtSignature || part.inlineData || part.fileData)) {
				end(output, stream);
				continue;
			}
			const text = part.text ?? "";
			const thinking = isThinkingPart(part);
			const existing =
				current?.block.type === "thinking" ? current.block.thinkingSignature : current?.block.textSignature;
			const boundary =
				(index > 0 && Boolean(existing || part.thoughtSignature)) ||
				Boolean(part.thoughtSignature && (text === "" || (existing && existing !== part.thoughtSignature)));
			if (!current || boundary || thinking !== (current.block.type === "thinking")) {
				end(output, stream);
				const block: TextContent | ThinkingContent = thinking
					? { type: "thinking", thinking: "" }
					: { type: "text", text: "" };
				current = { block, index: output.content.length };
				output.content.push(block);
				stream.push({ type: thinking ? "thinking_start" : "text_start", contentIndex: current.index, partial: output });
			}
			const block = current.block;
			if (block.type === "thinking") {
				block.thinking += text;
				block.thinkingSignature = retainThoughtSignature(block.thinkingSignature, part.thoughtSignature);
			} else {
				block.text += text;
				block.textSignature = retainThoughtSignature(block.textSignature, part.thoughtSignature);
			}
			stream.push({
				type: thinking ? "thinking_delta" : "text_delta",
				contentIndex: current.index,
				delta: text,
				partial: output,
			});
		}
		if (pending[0]?.part.functionCall) end(output, stream);
	};
	return {
		drain,
		end,
		append(parts: Part[]) {
			pending.push(
				...parts.flatMap((part, index) => (part.functionCall && !part.functionCall.name ? [] : [{ part, index }])),
			);
		},
		tool() {
			if (pending[0]?.part.functionCall) pending.shift();
		},
	};
}
