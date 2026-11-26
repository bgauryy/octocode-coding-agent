export interface ChatCompletionContentPartText {
	type: "text";
	text: string;
}
interface ChatCompletionContentPartImage {
	type: "image_url";
	image_url: { url: string; detail?: string };
}
type ChatCompletionContentPart = ChatCompletionContentPartText | ChatCompletionContentPartImage;
export interface ChatCompletionSystemMessageParam {
	role: "system";
	content: string | ChatCompletionContentPartText[];
}
export interface ChatCompletionDeveloperMessageParam {
	role: "developer";
	content: string | ChatCompletionContentPartText[];
}
export interface ChatCompletionToolMessageParam {
	role: "tool";
	content: string | ChatCompletionContentPartText[];
	tool_call_id: string;
}
export interface ChatCompletionAssistantMessageParam {
	role: "assistant";
	content?: string | ChatCompletionContentPartText[] | null;
	tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}
export type ChatCompletionMessageParam =
	| ChatCompletionSystemMessageParam
	| ChatCompletionDeveloperMessageParam
	| ChatCompletionToolMessageParam
	| ChatCompletionAssistantMessageParam
	| { role: "user"; content: string | ChatCompletionContentPart[] };
export type ChatCompletionTool =
	| {
			type: "function";
			function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
	  }
	| {
			type: "custom";
			custom: {
				name: string;
				description?: string;
				format: { type: "grammar"; grammar: { syntax: string; definition: string } };
			};
	  };
export type ChatCompletionToolChoiceOption =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; function: { name: string } }
	| { type: "custom"; custom: { name: string } };
export interface ChatCompletionCreateParamsStreaming {
	model: string;
	messages: ChatCompletionMessageParam[];
	stream: true;
	tools?: ChatCompletionTool[];
	tool_choice?: ChatCompletionToolChoiceOption;
	temperature?: number;
	max_tokens?: number;
	max_completion_tokens?: number;
	reasoning_effort?: string;
	stream_options?: { include_usage?: boolean };
	prompt_cache_key?: string;
	prompt_cache_retention?: string;
	[key: string]: unknown;
}
interface ResponseInputText {
	type: "input_text";
	text: string;
}
interface ResponseInputImage {
	type: "input_image";
	detail: "auto" | "low" | "high" | "original";
	image_url?: string;
	file_id?: string;
}
type ResponseInputContent = ResponseInputText | ResponseInputImage;
export interface ResponseOutputText {
	type: "output_text";
	text: string;
	annotations: Array<{
		type: string;
		url?: string;
		title?: string;
		filename?: string;
		file_id?: string;
		start_index?: number;
		end_index?: number;
		[key: string]: unknown;
	}>;
	logprobs?: unknown[];
}
interface ResponseOutputMessage {
	type: "message";
	id: string;
	role: "assistant";
	status: string;
	phase?: "commentary" | "final_answer" | null;
	content: Array<ResponseOutputText | { type: "refusal"; refusal: string }>;
}
export interface ResponseReasoningItem {
	type: "reasoning";
	id: string;
	encrypted_content?: string | null;
	summary: Array<{ type: "summary_text"; text: string }>;
	content?: Array<{ type: "reasoning_text"; text: string }>;
	status?: string;
}
type FunctionCall = {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
	namespace?: string;
	status?: string;
};
type CustomCall = {
	type: "custom_tool_call";
	id?: string;
	call_id: string;
	name: string;
	input: string;
	namespace?: string;
	status?: string;
};
type NativeType =
	| "compaction"
	| "image_generation_call"
	| "computer_call_output"
	| "web_search_call"
	| "file_search_call"
	| "code_interpreter_call"
	| "computer_call"
	| "shell_call"
	| "local_shell_call"
	| "shell_call_output"
	| "local_shell_call_output"
	| "function_call_output"
	| "custom_tool_call_output"
	| "apply_patch_call_output"
	| "apply_patch_call"
	| "program"
	| "program_output"
	| "mcp_call"
	| "mcp_approval_request"
	| "mcp_approval_response"
	| "mcp_list_tools"
	| "tool_search_call"
	| "tool_search_output"
	| "additional_tools";
type NativeOutput<T extends NativeType> = { type: T; id?: string; status?: string; [key: string]: unknown };
export type ResponseOutputItem =
	| ResponseOutputMessage
	| ResponseReasoningItem
	| FunctionCall
	| CustomCall
	| (NativeOutput<"image_generation_call"> & { result?: string | null; output_format?: string })
	| (NativeOutput<"computer_call_output"> & { output: { image_url?: string } })
	| (NativeOutput<"file_search_call"> & { queries: string[]; results?: Record<string, unknown>[] | null })
	| (NativeOutput<"code_interpreter_call"> & { code?: string | null; outputs?: Record<string, unknown>[] | null })
	| (NativeOutput<"shell_call_output"> & { output: Record<string, unknown>[] })
	| (NativeOutput<"mcp_list_tools" | "tool_search_output" | "additional_tools"> & { tools: Record<string, unknown>[] })
	| NativeOutput<
			Exclude<
				NativeType,
				| "image_generation_call"
				| "computer_call_output"
				| "file_search_call"
				| "code_interpreter_call"
				| "shell_call_output"
				| "mcp_list_tools"
				| "tool_search_output"
				| "additional_tools"
			>
	  >;
export type Tool =
	| {
			type: "function";
			name: string;
			description?: string;
			parameters: Record<string, unknown>;
			strict?: boolean | null;
			defer_loading?: boolean;
	  }
	| {
			type: "custom";
			name: string;
			description?: string;
			format: { type: "grammar"; syntax: string; definition: string };
			defer_loading?: boolean;
	  };
interface ResponseConfigurationUpdateItemParam {
	type: "configuration_update";
	reasoning: { effort?: string | null };
}
interface ResponseToolSearchOutputItemParam {
	type: "tool_search_output";
	call_id: string;
	execution: "client";
	status: string;
	tools: Tool[];
}
export type ResponseFunctionCallOutputItemList = ResponseInputContent[];
type ResponseInputItem =
	| ResponseOutputItem
	| ResponseConfigurationUpdateItemParam
	| ResponseToolSearchOutputItemParam
	| { type?: "message"; role: "system" | "developer" | "user"; content: string | ResponseInputContent[] }
	| { type: "additional_tools"; role: "developer"; tools: Tool[] }
	| {
			type: "tool_search_call";
			call_id: string;
			execution: "client";
			status: string;
			arguments: { query: string; limit: number };
	  }
	| {
			type: "function_call_output" | "custom_tool_call_output";
			call_id: string;
			output: string | ResponseInputContent[];
	  };
type ResponseInput = ResponseInputItem[];
export interface ResponseCreateParamsStreaming {
	model: string;
	input: string | ResponseInput;
	stream: true;
	service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | "fast" | "ultrafast" | null;
	tool_choice?: "auto" | "none" | "required" | { type: "function" | "custom"; name: string };
	[key: string]: unknown;
}
interface WireResponse {
	id: string;
	output: ResponseOutputItem[];
	status?: "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress";
	service_tier?: ResponseCreateParamsStreaming["service_tier"];
	usage?: {
		input_tokens: number;
		output_tokens: number;
		total_tokens: number;
		input_tokens_details?: { cached_tokens?: number };
		output_tokens_details?: { reasoning_tokens?: number };
	};
	incomplete_details?: { reason?: string } | null;
	error?: { code?: string; message?: string } | null;
	[key: string]: unknown;
}
type Event<T extends string, P> = T extends string ? { type: T; sequence_number?: number } & P : never;
export type ResponseStreamEvent =
	| Event<
			"response.created" | "response.completed" | "response.incomplete" | "response.failed",
			{ response: WireResponse }
	  >
	| Event<
			"response.output_item.added" | "response.output_item.done",
			{ output_index: number; item: ResponseOutputItem }
	  >
	| Event<
			| "response.reasoning_summary_text.delta"
			| "response.reasoning_text.delta"
			| "response.output_text.delta"
			| "response.refusal.delta"
			| "response.function_call_arguments.delta"
			| "response.custom_tool_call_input.delta",
			{
				output_index: number;
				item_id: string;
				delta: string;
				content_index?: number;
				summary_index?: number;
				logprobs?: unknown[];
			}
	  >
	| Event<
			"response.reasoning_summary_part.done",
			{ output_index: number; item_id: string; summary_index: number; part: { type: string; text: string } }
	  >
	| Event<
			"response.output_text.annotation.added",
			{
				output_index: number;
				annotation: ResponseOutputText["annotations"][number];
				item_id?: string;
				content_index?: number;
				annotation_index?: number;
			}
	  >
	| Event<
			"response.function_call_arguments.done",
			{ output_index: number; item_id: string; arguments: string; name?: string }
	  >
	| Event<"response.custom_tool_call_input.done", { output_index: number; item_id: string; input: string }>
	| Event<
			"response.image_generation_call.partial_image",
			{
				item_id: string;
				partial_image_b64: string;
				output_format?: string;
				output_index?: number;
				partial_image_index?: number;
			}
	  >
	| Event<"response.audio.delta" | "response.audio.transcript.delta", { delta: string }>
	| Event<"response.audio.done" | "response.audio.transcript.done", Record<string, unknown>>
	| Event<"error", { code?: string | null; message: string; param?: string | null }>;
