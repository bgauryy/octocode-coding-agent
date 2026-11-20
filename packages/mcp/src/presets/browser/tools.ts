import type { CallToolResult } from "../../client/index.ts";
import {
	createMcpToolDefinition,
	createMcpToolRenderers,
	type McpToolDefinitionOptions,
} from "../../tool-definition.ts";
import { toToolResult } from "../../tool-result.ts";
import { hostRender } from "../../host.ts";
import { imageLimits } from "@octocodeai/octocode-ai/utils/vision";
import { engineDetail } from "./failure.ts";
import { presentBrowserResult } from "./presentation.ts";
import { guardBrowserCall } from "./proxy.ts";
import { withStructuredText } from "../structured-text.ts";

/**
 * The Octocode tool for one browser server tool. Results share the generic result bounds (`toToolResult`): untrusted page text has its
 * control characters made visible, oversized text is saved whole to the session's output folder, and images fit the
 * active model. A saved screenshot reaches the model as an image beside its file paths, and a HAR without bodies is
 * flagged. Arguments reach the server as sent, except `open`, which the network filter starts behind its proxy.
 */
export function defineBrowserTool(options: McpToolDefinitionOptions) {
	const { tool } = options;
	const label = tool.title?.trim() || `browser ${tool.name}`;
	// The filter rewrites the package's launcher `args`; a user's own `browser` server with another `open` contract is left alone.
	const launcherArgs = tool.name !== "open" || Object.hasOwn(tool.inputSchema?.properties ?? {}, "args");
	return hostRender().timedTool(
		createMcpToolDefinition({
			...options,
			presentation: {
				label,
				...createMcpToolRenderers(label),
				prepareCall: (args, ctx) => (launcherArgs ? guardBrowserCall(tool.name, args, ctx.cwd, ctx.signal) : { args }),
				async convertResult(result, ctx) {
					const limits = imageLimits(ctx.model);
					const detail = await engineDetail(result, ctx.cwd);
					const structured = withStructuredText(result);
					const text: CallToolResult = detail
						? { ...structured, content: [...structured.content, { type: "text", text: detail }] }
						: structured;
					const shown = await presentBrowserResult(tool.name, text, { cwd: ctx.cwd, limits });
					const converted = await toToolResult(tool.name, shown, false, limits);
					return { ...converted, details: { ...converted.details, server: options.server } };
				},
			},
		}),
	);
}
