import { imageLimits } from "@octocodeai/octocode-ai/utils/vision";
import { hostRender } from "../../host.ts";
import {
	createMcpToolDefinition,
	createMcpToolRenderers,
	type McpToolDefinitionOptions,
} from "../../tool-definition.ts";
import { toToolResult } from "../../tool-result.ts";
import { withStructuredText } from "../structured-text.ts";

/**
 * The Octocode tool for one Cua Driver tool. The server answers with a one-line text ("Found 97 window(s).") and
 * keeps the data the next call needs (`snapshot_id`, `element_token`, window ids, the accessibility tree) only in
 * `structuredContent`, so the evidence follows the acknowledgement as compact JSON (`withStructuredText`). Results share
 * the generic bounds (`toToolResult`): oversized text is saved whole, and a screenshot fits the active model.
 */
export function defineDesktopTool(options: McpToolDefinitionOptions) {
	const label = options.tool.title?.trim() || `desktop ${options.tool.name}`;
	return hostRender().timedTool(
		createMcpToolDefinition({
			...options,
			presentation: {
				label,
				...createMcpToolRenderers(label),
				async convertResult(result, ctx) {
					const converted = await toToolResult(
						options.tool.name,
						withStructuredText(result),
						false,
						imageLimits(ctx.model),
					);
					return { ...converted, details: { ...converted.details, server: options.server } };
				},
			},
		}),
	);
}
