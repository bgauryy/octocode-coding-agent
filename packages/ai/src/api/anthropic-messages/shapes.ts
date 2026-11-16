export interface CacheControlEphemeral {
	type: "ephemeral";
	ttl?: "5m" | "1h";
}

export type CacheMissReason =
	| {
			type: "model_changed" | "system_changed" | "tools_changed" | "messages_changed";
			cache_missed_input_tokens: number;
	  }
	| { type: "previous_message_not_found" | "unavailable" };
export interface Diagnostics {
	cache_miss_reason: CacheMissReason | null;
}
export interface DiagnosticsParam {
	previous_message_id?: string | null;
}

export type ContentBlock =
	| { type: "container_upload"; file_id: string }
	| {
			type: "mcp_tool_listing";
			mcp_server_name: string;
			tools: { name: string; description?: string | null; input_schema?: unknown }[];
	  }
	| { type: "compaction"; content: string | null }
	| {
			type:
				| "fallback"
				| "text"
				| "thinking"
				| "redacted_thinking"
				| "tool_use"
				| "server_tool_use"
				| "mcp_tool_use"
				| "web_search_tool_result"
				| "web_fetch_tool_result"
				| "advisor_tool_result"
				| "code_execution_tool_result"
				| "bash_code_execution_tool_result"
				| "text_editor_code_execution_tool_result"
				| "tool_search_tool_result"
				| "mcp_tool_result";
			tool_use_id?: string;
			content?: unknown;
			id?: string;
			name?: string;
			input?: unknown;
			server_name?: string;
			is_error?: boolean;
	  };

export interface TextCitation {
	type: string;
	cited_text: string;
	url?: string;
	source?: string;
	title?: string | null;
	document_title?: string | null;
	file_id?: string | null;
	document_index?: number;
	start_char_index?: number;
	end_char_index?: number;
	start_page_number?: number;
	end_page_number?: number;
}
