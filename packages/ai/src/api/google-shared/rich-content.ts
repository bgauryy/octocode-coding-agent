import type { Candidate, Part } from "@google/genai";
import type { AssistantContent, AssistantMessage, ContentAnnotation, TextContent } from "../../types.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { outputFields, providerOutputText } from "../provider-output.ts";

export function googleArtifact(part: Part): AssistantContent | undefined {
	const thoughtSignature = part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {};
	if (part.inlineData) {
		const { data, mimeType = "application/octet-stream" } = part.inlineData;
		if (data) return { type: mimeType.startsWith("image/") ? "image" : "media", data, mimeType, ...thoughtSignature };
		return { type: "unsupported", providerType: "inlineData", text: `Empty provider attachment (${mimeType})` };
	}
	if (part.fileData?.fileUri) {
		return { type: "resource", uri: part.fileData.fileUri, mimeType: part.fileData.mimeType, ...thoughtSignature };
	}
	if (part.executableCode) {
		return {
			type: "text",
			text: `\n\`\`\`${part.executableCode.language?.toLowerCase() ?? ""}\n${part.executableCode.code ?? ""}\n\`\`\`\n`,
		};
	}
	if (part.codeExecutionResult) {
		return {
			type: "text",
			text: `${part.codeExecutionResult.outcome ?? "Code execution"}\n${part.codeExecutionResult.output ?? ""}`,
		};
	}
	if (part.audioTranscription?.text) return { type: "text", text: part.audioTranscription.text };
	if (part.toolCall) return providerOutputText("toolCall", outputFields(part.toolCall, ["id", "toolType", "args"]));
	if (part.toolResponse)
		return providerOutputText("toolResponse", outputFields(part.toolResponse, ["id", "toolType", "response"]));
	if (part.functionResponse)
		return providerOutputText(
			"functionResponse",
			outputFields(part.functionResponse, ["id", "name", "response", "parts", "willContinue"]),
		);
	return undefined;
}

/** Keep citation sources even when a provider sends them in a metadata-only final chunk. */
export function applyGoogleAnnotations(
	output: AssistantMessage,
	candidate: Candidate | undefined,
	stream: AssistantMessageEventStream,
): void {
	const annotations: ContentAnnotation[] = (candidate?.citationMetadata?.citations ?? []).map((citation) => ({
		type: "citation",
		url: citation.uri,
		title: citation.title,
		startIndex: citation.startIndex,
		endIndex: citation.endIndex,
	}));
	const grounding = candidate?.groundingMetadata;
	for (const [index, chunk] of (grounding?.groundingChunks ?? []).entries()) {
		const source = chunk.web ?? chunk.retrievedContext ?? chunk.maps;
		if (!source) continue;
		const supports =
			grounding?.groundingSupports?.filter((support) => support.groundingChunkIndices?.includes(index)) ?? [];
		for (const support of supports.length ? supports : [undefined]) {
			annotations.push({
				type: "grounding",
				url: source.uri,
				title: source.title,
				text: support?.segment?.text,
				// Google segment offsets are UTF-8 bytes within a provider Part, not offsets in our
				// merged text block. Keep the quoted segment rather than inventing character ranges.
			});
		}
	}
	if (!annotations.length) return;
	let texts = output.content.filter((block): block is TextContent => block.type === "text");
	if (!texts.length) {
		const sourceText: TextContent = { type: "text", text: "Sources" };
		output.content.push(sourceText);
		texts = [sourceText];
	}
	let offset = 0;
	for (const block of texts) {
		const relevant = annotations.filter(
			(a) =>
				a.startIndex === undefined ||
				a.endIndex === undefined ||
				(a.startIndex < offset + block.text.length && a.endIndex > offset),
		);
		const existing = new Set((block.annotations ?? []).map((annotation) => JSON.stringify(annotation)));
		let changed = false;
		for (const annotation of relevant) {
			const local = {
				...annotation,
				...(annotation.startIndex === undefined ? {} : { startIndex: Math.max(0, annotation.startIndex - offset) }),
				...(annotation.endIndex === undefined
					? {}
					: { endIndex: Math.min(block.text.length, annotation.endIndex - offset) }),
			};
			const key = JSON.stringify(local);
			if (existing.has(key)) continue;
			(block.annotations ??= []).push(local);
			existing.add(key);
			changed = true;
		}
		if (changed) stream.push({ type: "content_update", contentIndex: output.content.indexOf(block), partial: output });
		offset += block.text.length;
	}
}
