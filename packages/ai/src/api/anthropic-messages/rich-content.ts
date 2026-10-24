import type { BetaContentBlock, BetaTextCitation } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { ContentAnnotation, TextContent } from "../../types.ts";
import { outputFields, providerOutputText } from "../provider-output.ts";

export function anthropicNativeFields(block: BetaContentBlock): Record<string, unknown> | undefined {
	switch (block.type) {
		case "server_tool_use":
		case "mcp_tool_use":
			return outputFields(block, ["id", "name", "input", "server_name"]);
		case "web_search_tool_result":
		case "web_fetch_tool_result":
		case "advisor_tool_result":
		case "code_execution_tool_result":
		case "bash_code_execution_tool_result":
		case "text_editor_code_execution_tool_result":
		case "tool_search_tool_result":
		case "mcp_tool_result":
			return outputFields(block, ["tool_use_id", "content", "is_error"]);
		case "container_upload":
			return { file_id: block.file_id };
		case "mcp_tool_listing":
			return {
				server: block.mcp_server_name,
				tools: block.tools.map((tool) => outputFields(tool, ["name", "description", "input_schema"])),
			};
		default:
			return undefined;
	}
}

export function anthropicNativeOutput(block: BetaContentBlock): TextContent | undefined {
	if (block.type === "compaction" && block.content)
		return { type: "text", text: `Provider compaction:\n${block.content}` };
	const fields = anthropicNativeFields(block);
	return fields ? providerOutputText(block.type, fields) : undefined;
}

export function anthropicAnnotation(citation: BetaTextCitation): ContentAnnotation {
	return {
		type: citation.type,
		text: citation.cited_text,
		...("url" in citation ? { url: citation.url } : {}),
		...("source" in citation ? { url: citation.source } : {}),
		...("title" in citation && citation.title ? { title: citation.title } : {}),
		...("document_title" in citation && citation.document_title ? { title: citation.document_title } : {}),
		...("file_id" in citation && citation.file_id ? { fileId: citation.file_id } : {}),
		...("document_index" in citation ? { documentIndex: citation.document_index } : {}),
		...("start_char_index" in citation
			? { startIndex: citation.start_char_index, endIndex: citation.end_char_index }
			: {}),
		...("start_page_number" in citation
			? { startPage: citation.start_page_number, endPage: citation.end_page_number }
			: {}),
	};
}
