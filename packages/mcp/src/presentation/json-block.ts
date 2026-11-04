import type { Tool as McpTool } from "../client/index.ts";
import { literal } from "../compact/schema-nodes.ts";

/**
 * One tool in plain form: the name the model calls it by, the server's own description, and the server's input (and
 * output) JSON Schema as sent. The block for a tool the TypeScript renderer cannot express faithfully
 * (`checkToolBlock`), and for every tool when `mcpPresentation` is `json`. Nothing is rewritten, so it cannot lose
 * what the schema says; it costs more characters than the typed signature (`schema-to-ts.ts`) for the same tool.
 */
export function jsonToolBlock(call: string, tool: McpTool): string {
	const description = tool.description?.trim() || tool.title?.trim();
	return [
		`// ${call}`,
		...(description ? [description] : []),
		`Input schema (JSON Schema): ${literal(tool.inputSchema)}`,
		...(tool.outputSchema ? [`Output schema (JSON Schema): ${literal(tool.outputSchema)}`] : []),
	].join("\n");
}

/**
 * A server's contract with no generated file: its instructions once, then each tool in plain form. The header says
 * how to call the tools, as the generated file's header does.
 */
export function jsonContract(server: string, instructions: string | undefined, blocks: readonly string[]): string {
	const text = instructions?.trim();
	return [
		`// MCP server "${server.replace(/[\r\n"]+/g, " ")}" · call a tool by the name on its // line, with the input object.`,
		...(text ? [text] : []),
		...blocks,
	].join("\n");
}
