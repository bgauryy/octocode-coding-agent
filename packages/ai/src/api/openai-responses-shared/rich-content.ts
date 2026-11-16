import type { ResponseOutputItem, ResponseOutputText } from "../ai-sdk/openai-wire-types.ts";
import type { AssistantContent, ContentAnnotation } from "../../types.ts";
import { responseNativeOutput } from "./native-output.ts";

export function responseAnnotation(
	annotation: ResponseOutputText["annotations"][number],
	offset = 0,
): ContentAnnotation {
	return {
		type: annotation.type,
		...("url" in annotation ? { url: annotation.url } : {}),
		...("title" in annotation ? { title: annotation.title } : {}),
		...("filename" in annotation ? { title: annotation.filename } : {}),
		...("file_id" in annotation ? { fileId: annotation.file_id } : {}),
		...(typeof annotation.start_index === "number" ? { startIndex: offset + annotation.start_index } : {}),
		...(typeof annotation.end_index === "number" ? { endIndex: offset + annotation.end_index } : {}),
	};
}

/** Provider-native output items stay visible even when this client cannot execute or display their payload. */
export function responseArtifact(item: ResponseOutputItem): AssistantContent {
	if (item.type === "image_generation_call" && item.result) {
		return { type: "image", data: item.result, mimeType: `image/${item.output_format ?? "png"}` };
	}
	if (item.type === "computer_call_output" && item.output.image_url) {
		const embedded = item.output.image_url.match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
		return embedded
			? { type: "image", mimeType: embedded[1], data: embedded[2] }
			: { type: "resource", uri: item.output.image_url, name: "Computer screenshot" };
	}
	const native = responseNativeOutput(item);
	if (native) return native;
	const status = "status" in item && typeof item.status === "string" ? ` (${item.status})` : "";
	return { type: "unsupported", providerType: item.type, text: `Provider output: ${item.type}${status}` };
}

export function responseAnnotations(item: Extract<ResponseOutputItem, { type: "message" }>): ContentAnnotation[] {
	let offset = 0;
	return item.content.flatMap((part) => {
		const annotations =
			part.type === "output_text" ? (part.annotations ?? []).map((a) => responseAnnotation(a, offset)) : [];
		offset += part.type === "output_text" ? part.text.length : part.refusal.length;
		return annotations;
	});
}
