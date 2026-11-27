import type { AgentContext } from "./capture.ts";

/** A tool declaration as the model receives it: name, description and parameter schema. */
export function declaration(tool: AgentContext["tools"][number]): string {
	return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters });
}

export const isMcpTool = (name: string): boolean => name.startsWith("mcp__");
