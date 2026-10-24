import type { AgentToolResult } from "@octocodeai/octocode-agent-core";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	outputPad?: number;
}

export type ToolExecutionResult = Pick<AgentToolResult, "structuredContent" | "usage" | "terminate"> & {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError: boolean;
	details?: any;
	durationMs?: number;
};
