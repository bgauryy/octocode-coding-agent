import type { CallToolResult } from "../../client/index.ts";
import {
	createMcpToolDefinition,
	createMcpToolRenderers,
	type McpToolDefinitionOptions,
} from "../../tool-definition.ts";
import { toToolResult } from "../../tool-result.ts";
import { hostRender } from "../../host.ts";
import { imageLimits } from "@octocodeai/octocode-ai/utils/vision";
import { guardBrowserCall } from "./proxy.ts";
import { withStructuredText } from "../structured-text.ts";

/**
 * The Octocode tool for one browser server tool. The server's name, description and schema are declared as served.
 * Results share the generic result bounds (`toToolResult`): untrusted page text has its control characters made
 * visible, oversized text is saved whole to the session's output folder, and images fit the active model. Arguments
 * reach the server as sent, except `open`, which the network filter starts behind its proxy.
 */
export function defineBrowserTool(options: McpToolDefinitionOptions) {
	const { tool } = options;
	const label = tool.title?.trim() || `browser ${tool.name}`;
	// The filter rewrites the package's `launch` field; a user's own `browser` server with another `open` contract is left alone.
	const launchField = tool.name !== "open" || Object.hasOwn(tool.inputSchema?.properties ?? {}, "launch");
	return hostRender().timedTool(
		createMcpToolDefinition({
			...options,
			presentation: {
				label,
				...createMcpToolRenderers(label),
				prepareCall: (args, ctx) => (launchField ? guardBrowserCall(tool.name, args, ctx.cwd, ctx.signal) : { args }),
				async convertResult(result: CallToolResult, ctx) {
					const limits = imageLimits(ctx.model);
					const converted = await toToolResult(tool.name, withStructuredText(result), false, limits);
					return { ...converted, details: { ...converted.details, server: options.server } };
				},
			},
		}),
	);
}
