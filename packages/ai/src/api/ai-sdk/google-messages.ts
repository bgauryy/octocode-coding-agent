import type { ImageContent, Model, Message, TranscriptContext } from "../../types.ts";
import { normalizeContext } from "../../utils/transcript.ts";
import { supportsMultimodalFunctionResponse } from "./google-capabilities.ts";
import { sdkMessages } from "./messages.ts";

export function googleSdkMessages(model: Model<"google-generative-ai" | "google-vertex">, context: TranscriptContext) {
	const messages: Message[] = [];
	const nested = supportsMultimodalFunctionResponse(model.id);
	let images: ImageContent[] = [];
	const flush = () => {
		if (!images.length) return;
		messages.push({ role: "user", content: [{ type: "text", text: "Tool result image:" }, ...images], timestamp: 0 });
		images = [];
	};
	for (const message of context.messages) {
		if (message.role !== "toolResult") {
			flush();
			messages.push(message);
			continue;
		}
		const attachments = message.content.filter((part) => part.type === "image");
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const value = text.trim() ? text : attachments.length ? "(see attached image)" : "";
		if (!nested) images.push(...attachments);
		messages.push({ ...message, content: [{ type: "text", text: value }, ...(nested ? attachments : [])] });
	}
	flush();
	return sdkMessages(model, normalizeContext({ ...context, messages }));
}
