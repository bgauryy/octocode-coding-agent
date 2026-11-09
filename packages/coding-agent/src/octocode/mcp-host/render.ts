/**
 * The MCP workspace's tool-row render port: tool headers, result blocks and timing.
 * `installMcpRenderPort()` is the composition root for it; it is idempotent.
 */

import { renderInstruction } from "../../core/prompt-template.ts";
import { installMcpHost, type McpHostPorts } from "../../../../mcp/src/host.ts";
import { formatToolCallWithArgs, getTextOutput } from "../../core/tools/render-utils.ts";
import type { Theme } from "../../theme/theme.ts";
import { resultBlock, resultText, toolHeader } from "../render/tool.ts";
import { timedTool, timingOf } from "../render/rows.ts";

const render: McpHostPorts["render"] = {
	instruction: renderInstruction,
	toolHeader: (theme, context, name, summary, options) => toolHeader(theme as Theme, context, name, summary, options),
	resultBlock: (theme, context, options) =>
		resultBlock(theme as Theme, context, options as Parameters<typeof resultBlock>[2]),
	resultText,
	timingOf,
	timedTool: (tool) => timedTool(tool as never) as never,
	formatToolCallWithArgs: (title, args, theme, expanded) =>
		formatToolCallWithArgs(title, args, theme as Theme, expanded),
	getTextOutput,
};

export function installMcpRenderPort(): void {
	installMcpHost({ render });
}
