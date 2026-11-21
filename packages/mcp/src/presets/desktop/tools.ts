import { imageLimits } from "@octocodeai/octocode-ai/utils/vision";
import { hostRender } from "../../host.ts";
import {
	createMcpToolDefinition,
	createMcpToolRenderers,
	type McpToolDefinitionOptions,
} from "../../tool-definition.ts";
import { toToolResult } from "../../tool-result.ts";
import { projectDesktopResult } from "./projection.ts";

/** What a window read gets when the call sets neither bound: an unbounded read of a simple app returned tens of thousands of characters. */
const WINDOW_READ_BOUNDS = { max_depth: 3, max_elements: 40 } as const;

/**
 * The arguments of a call. A `get_window_state` that names no bound is bounded, and one that names neither a screenshot
 * request nor a file to save it in gets none: Driver attaches an image to every plain read, and an image stays in every
 * later request of the child. A call that names either keeps its own choice (the evidence screenshot is asked for with
 * `screenshot_out_file`).
 */
export function boundedWindowRead(tool: string, args: Record<string, unknown>): Record<string, unknown> {
	if (tool !== "get_window_state") return args;
	const bounded =
		args.max_depth !== undefined || args.max_elements !== undefined ? args : { ...WINDOW_READ_BOUNDS, ...args };
	const pictured = bounded.include_screenshot !== undefined || bounded.screenshot_out_file !== undefined;
	return pictured ? bounded : { ...bounded, include_screenshot: false };
}

/**
 * The Octocode tool for one Cua Driver tool. The server answers with a one-line text ("Found 97 window(s).") and
 * keeps the data the next call needs (`snapshot_id`, `element_token`, window ids, the accessibility tree) only in
 * `structuredContent`, so the evidence follows the acknowledgement as compact JSON, projected per tool to the fields the next call needs
 * (`projectDesktopResult`; a tool without a projection keeps its whole JSON). Results share
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
				prepareCall: (args) => ({ args: boundedWindowRead(options.tool.name, args) }),
				async convertResult(result, ctx) {
					const converted = await toToolResult(
						options.tool.name,
						projectDesktopResult(options.tool.name, result),
						false,
						imageLimits(ctx.model),
					);
					return { ...converted, details: { ...converted.details, server: options.server } };
				},
			},
		}),
	);
}
