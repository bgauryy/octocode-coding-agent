/**
 * How the prompt describes MCP tools. `declared`: each tool's provider declaration carries the server's own description
 * and full input JSON Schema, and the prompt's block holds only the server's instructions. `compact` and `json`: thin
 * declarations, with the tools' contracts in the prompt's block (a generated TypeScript file, or plain JSON).
 */
export type McpPresentationMode = "declared" | "compact" | "json";
export const DEFAULT_MCP_PRESENTATION: McpPresentationMode = "declared";
