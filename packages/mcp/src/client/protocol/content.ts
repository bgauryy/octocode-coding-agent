export interface TextContent {
	type: "text";
	text: string;
	_meta?: Record<string, unknown>;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
	_meta?: Record<string, unknown>;
}

export interface AudioContent {
	type: "audio";
	data: string;
	mimeType: string;
	_meta?: Record<string, unknown>;
}

export type ContentBlock = TextContent | ImageContent | AudioContent;

export interface CallToolResult {
	content: ContentBlock[];
	/** Any JSON value, including arrays and `null` (MCP 2026-07-28; earlier revisions allowed only objects). */
	structuredContent?: unknown;
	isError?: boolean;
	_meta?: Record<string, unknown>;
}

/**
 * Tool result content in the shape LLM APIs accept: text and base64 images. Matches the
 * `TextContent` and `ImageContent` types of `@octocodeai/octocode-ai`.
 */
export type LlmContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function blockToLlmContent(block: ContentBlock): LlmContent {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "image":
			return { type: "image", data: block.data, mimeType: block.mimeType };
		case "audio":
			return { type: "text", text: `[audio ${block.mimeType} omitted]` };
		default:
			return { type: "text", text: `[unsupported MCP content ${(block as { type: string }).type}]` };
	}
}

/** Convert tool text and images for a model, with placeholders for unsupported content. */
export function toLlmContent(result: Pick<CallToolResult, "content" | "structuredContent">): LlmContent[] {
	const content = (result.content ?? []).map(blockToLlmContent);
	if (content.length === 0 && result.structuredContent !== undefined) {
		content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
	}
	return content;
}
