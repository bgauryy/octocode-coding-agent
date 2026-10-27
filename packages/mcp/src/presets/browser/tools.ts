import type { CallToolResult } from "../../client/index.ts";
import {
	createMcpToolDefinition,
	createMcpToolRenderers,
	type McpToolDefinitionOptions,
} from "../../tool-definition.ts";
import { toToolResult } from "../octocode/tools.ts";
import { timedTool } from "../../../../coding-agent/src/octocode/shared/render/rows.ts";
import { imageLimits } from "../../../../coding-agent/src/octocode/shared/vision.ts";
import { presentBrowserResult } from "./presentation.ts";
import { normalizeBrowserArguments } from "./presentation-options.ts";
import { guardBrowserCall } from "./proxy.ts";

/**
 * The browser server acknowledges a call with a short text ("OK") and returns its evidence (flow steps, failures,
 * captures and `next.*` continuations) only in `structuredContent`. The model reads text, so the evidence follows the
 * acknowledgement as compact JSON. A text block that already carries the same JSON (the server's error envelope) is
 * left as it is.
 */
export function withStructuredText(result: CallToolResult): CallToolResult {
	if (result.structuredContent === undefined) return result;
	const json = JSON.stringify(result.structuredContent);
	const content = result.content ?? [];
	if (content.some((block) => block.type === "text" && block.text.includes(json))) return result;
	const ack = content
		.flatMap((block) => (block.type === "text" ? [block.text.trim()] : []))
		.filter(Boolean)
		.join("\n");
	return {
		...result,
		content: [
			...content.filter((block) => block.type !== "text"),
			{ type: "text", text: ack ? `${ack}\n${json}` : json },
		],
	};
}

/**
 * The Octocode tool for one browser server tool. Results share the Octocode preset's bounds: untrusted page text has its
 * control characters made visible, oversized text is saved whole to the session's output folder, and images fit the
 * active model. A saved screenshot reaches the model as an image beside its file paths, `options` values the engine
 * would ignore are normalized before the call, and a HAR without bodies is flagged.
 */
export function defineBrowserTool(options: McpToolDefinitionOptions) {
	const { tool } = options;
	const label = tool.title?.trim() || `browser ${tool.name}`;
	// The filter rewrites the package's launcher `args`; a user's own `browser` server with another `open` contract is left alone.
	const launcherArgs = tool.name !== "open" || Object.hasOwn(tool.inputSchema?.properties ?? {}, "args");
	return timedTool(
		createMcpToolDefinition({
			...options,
			presentation: {
				label,
				...createMcpToolRenderers(label),
				prepareCall: (args, ctx) => {
					const normalized = normalizeBrowserArguments(tool.name, args);
					return launcherArgs ? guardBrowserCall(tool.name, normalized, ctx.cwd) : { args: normalized };
				},
				async convertResult(result, ctx) {
					const limits = imageLimits(ctx.model);
					const shown = await presentBrowserResult(tool.name, withStructuredText(result), { cwd: ctx.cwd, limits });
					const converted = await toToolResult(tool.name, shown, false, limits);
					return { ...converted, details: { ...converted.details, server: options.server } };
				},
			},
		}),
	);
}
