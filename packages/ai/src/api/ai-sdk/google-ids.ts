import type { ModelMessage } from "ai";
import { fitToolCallId } from "../tool-call-id.ts";
import { requiresToolCallId } from "./google-capabilities.ts";

interface WirePart {
	functionCall?: { id?: string };
	functionResponse?: { id?: string };
}

export function googleRequestIds(modelId: string, messages: ModelMessage[]) {
	const calls = messages.flatMap((message) =>
		message.role === "assistant"
			? message.content instanceof Array
				? message.content.flatMap((part) => (part.type === "tool-call" ? [fitToolCallId(part.toolCallId)] : []))
				: []
			: [],
	);
	const responses = messages.flatMap((message) =>
		message.role === "tool"
			? message.content.flatMap((part) => (part.type === "tool-result" ? [fitToolCallId(part.toolCallId)] : []))
			: [],
	);
	return (body: Record<string, unknown>) => {
		const contents = body.contents as { parts?: WirePart[] }[] | undefined;
		let callIndex = 0;
		let responseIndex = 0;
		for (const content of contents ?? [])
			for (const part of content.parts ?? []) {
				if (part.functionCall) {
					if (requiresToolCallId(modelId)) part.functionCall.id = calls[callIndex++];
					else delete part.functionCall.id;
				}
				if (part.functionResponse) {
					if (requiresToolCallId(modelId)) part.functionResponse.id = responses[responseIndex++];
					else delete part.functionResponse.id;
				}
			}
	};
}
