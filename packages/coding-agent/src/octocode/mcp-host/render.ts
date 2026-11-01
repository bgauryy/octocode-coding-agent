/**
 * The MCP workspace's tool-row render port: tool headers and result blocks, timing and the skill header.
 * `installMcpRenderPort()` is the composition root for it; it is idempotent.
 */

import { installMcpHost, type McpHostPorts } from "../../../../mcp/src/host.ts";
import { formatToolCallWithArgs, getTextOutput } from "../../core/tools/render-utils.ts";
import type { Theme } from "../../theme/theme.ts";
import { resultBlock, resultText, toolHeader } from "../shared/render.ts";
import { timedTool, timingOf } from "../shared/render/rows.ts";
import { skillNameOfRead } from "../skill/catalog.ts";
import { skillHeader } from "../skill/render.ts";

const render: McpHostPorts["render"] = {
	toolHeader: (theme, context, name, summary, options) => toolHeader(theme as Theme, context, name, summary, options),
	resultBlock: (theme, context, options) =>
		resultBlock(theme as Theme, context, options as Parameters<typeof resultBlock>[2]),
	resultText,
	timingOf,
	timedTool: (tool) => timedTool(tool as never) as never,
	skillNameOfRead,
	skillHeader: (theme, context, name) => skillHeader(theme as Theme, context, name),
	formatToolCallWithArgs: (title, args, theme, expanded) =>
		formatToolCallWithArgs(title, args, theme as Theme, expanded),
	getTextOutput,
};

export function installMcpRenderPort(): void {
	installMcpHost({ render });
}
