import type { ResponseOutputItem } from "openai/resources/responses/responses.js";
import type { TextContent } from "../../types.ts";
import { outputFields, providerOutputText } from "../provider-output.ts";

/** Installed Responses output shapes with user-visible fields; execution configuration and replay data stay private. */
export function responseNativeOutput(item: ResponseOutputItem): TextContent | undefined {
	const status = "status" in item ? item.status : undefined;
	const fields = (...keys: string[]) => outputFields(item, keys);
	let visible: Record<string, unknown>;
	switch (item.type) {
		case "web_search_call":
			visible = { action: outputFields(item.action, ["type", "query", "queries", "url", "pattern", "sources"]) };
			break;
		case "file_search_call":
			visible = {
				queries: item.queries,
				results: item.results?.map((result) =>
					outputFields(result, ["file_id", "filename", "score", "text", "attributes"]),
				),
			};
			break;
		case "code_interpreter_call":
			visible = {
				code: item.code,
				outputs: item.outputs?.map((output) => outputFields(output, ["type", "logs", "url"])),
			};
			break;
		case "computer_call":
			visible = fields("action", "actions", "pending_safety_checks");
			break;
		case "shell_call":
			visible = { action: outputFields(item.action, ["commands", "max_output_length", "timeout_ms"]) };
			break;
		case "local_shell_call":
			visible = { action: outputFields(item.action, ["type", "command", "timeout_ms", "working_directory", "user"]) };
			break;
		case "shell_call_output":
			visible = { output: item.output.map((output) => outputFields(output, ["stdout", "stderr", "outcome"])) };
			break;
		case "local_shell_call_output":
		case "function_call_output":
		case "custom_tool_call_output":
		case "apply_patch_call_output":
			visible = fields("output");
			break;
		case "apply_patch_call":
			visible = { operation: outputFields(item.operation, ["type", "path", "diff"]) };
			break;
		case "program":
			visible = { code: item.code };
			break;
		case "program_output":
			visible = { result: item.result };
			break;
		case "mcp_call":
		case "mcp_approval_request":
			visible = fields("name", "server_label", "arguments", "output", "error");
			break;
		case "mcp_approval_response":
			visible = fields("approve", "reason");
			break;
		case "mcp_list_tools":
			visible = {
				server: item.server_label,
				error: item.error,
				tools: item.tools.map((tool) => outputFields(tool, ["name", "description", "input_schema"])),
			};
			break;
		case "tool_search_call":
			visible = fields("arguments", "execution");
			break;
		case "tool_search_output":
		case "additional_tools":
			visible = {
				tools: item.tools.map((tool) =>
					outputFields(tool, ["type", "name", "description", "parameters", "input_schema"]),
				),
			};
			break;
		default:
			return undefined;
	}
	return providerOutputText(item.type, { ...visible, ...(status === undefined ? {} : { status }) });
}
