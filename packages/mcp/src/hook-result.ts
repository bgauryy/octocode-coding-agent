import type { CallToolResult, ContentBlock } from "./client/index.ts";
import { hostOutput } from "./host.ts";

/**
 * A hook's MCP reply within the host text cap, as the model path bounds it: a text block past the cap keeps its start
 * and end (the full text saved to a file), an image is fitted, audio past the cap becomes a note, and oversized
 * `structuredContent` becomes a stub naming the file that holds its JSON.
 */
export async function boundHookResult(result: CallToolResult, label: string): Promise<CallToolResult> {
	const output = hostOutput();
	const cap = output.textMaxChars;
	const content: ContentBlock[] = [];
	for (const block of result.content) {
		if (block.type === "text") content.push({ ...block, text: output.capResultText(block.text, label) });
		else if (block.type === "image") content.push(...(await output.boundImagePart(block, label)));
		else if (block.data.length > cap)
			content.push({ type: "text", text: `Audio omitted (${block.data.length} base64 characters).` });
		else content.push(block);
	}
	let structuredContent = result.structuredContent;
	const json = structuredContent === undefined ? undefined : JSON.stringify(structuredContent);
	if (json !== undefined && json.length > cap) {
		const file = output.saveFullOutput(json, "mcp-hook-structured");
		structuredContent = { truncated: true, chars: json.length, ...(file ? { fullOutputPath: file } : {}) };
	}
	return { ...result, content, ...(structuredContent === undefined ? {} : { structuredContent }) };
}
