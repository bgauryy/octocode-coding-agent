import type { ApplicationTool } from "@octocodeai/octocode-contracts";
import type { ApplicationAssets } from "./assets.ts";

/** The largest serialized tool display the transcript keeps inline; a larger one moves to an asset. */
const TOOL_CHARS = 60000;

/** Move an oversized tool result display into an asset and leave a placeholder; smaller data is returned as is. */
export function spillToolData(
	data: Partial<ApplicationTool>,
	id: string,
	assets: ApplicationAssets,
	streaming: boolean,
): Partial<ApplicationTool> {
	if (JSON.stringify(data).length <= TOOL_CHARS) return data;
	data.full = assets.put(
		JSON.stringify(data),
		"application/json",
		"utf8",
		undefined,
		streaming ? `tool:${id}:full` : undefined,
	);
	data.content = [
		{
			id: `tool:${id}:full`,
			type: "unsupported",
			providerType: "large-tool-result",
			text: "Full tool result available",
		},
	];
	data.text = "[Full tool result available]";
	delete data.usage;
	delete data.details;
	delete data.structuredContent;
	return data;
}

/** Move an oversized tool state into an asset and leave a placeholder; a running tool keeps one asset slot. */
export function spillTool(tool: ApplicationTool, assets: ApplicationAssets, completed: boolean): ApplicationTool {
	if (JSON.stringify(tool).length <= TOOL_CHARS) return tool;
	tool.full = assets.put(
		JSON.stringify(tool),
		"application/json",
		"utf8",
		undefined,
		completed ? undefined : `tool:${tool.toolCallId}:state`,
	);
	tool.arguments = undefined;
	tool.details = undefined;
	tool.structuredContent = undefined;
	tool.usage = undefined;
	tool.content = [
		{
			id: `tool:${tool.toolCallId}:full`,
			type: "unsupported",
			providerType: "large-tool-result",
			text: "Full tool data available",
		},
	];
	tool.text = "[Full tool data available]";
	// The header and outcome stay; the blocks are in the asset with everything else.
	if (tool.display) {
		const { preface: _preface, ...display } = tool.display;
		tool.display = { ...display, blocks: [{ type: "text", text: "[Full tool data available]" }] };
	}
	return tool;
}
