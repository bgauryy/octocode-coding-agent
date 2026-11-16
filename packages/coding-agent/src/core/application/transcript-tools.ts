import type { ApplicationTool } from "@octocodeai/octocode-contracts";
import type { ApplicationAssets } from "./assets.ts";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { recordJsonLength } from "@octocodeai/octocode-common/json-length";
import { savedOutputTwin } from "../tools/bash/stored-result.ts";

/** The result a tool's displayed data was last built from. */
export interface ToolSource {
	value: unknown;
	owner: string;
	streaming: boolean;
	/** Output projection is authoritative; result renderers must not read the original instead. */
	projected?: boolean;
}

/**
 * The source the transcript keeps of a finished result: a bash result's structured data in its released form
 * (`savedOutputTwin`), the one its message will hold, so the 1 MiB output for programmatic callers is read from its
 * saved file only when a reprojection reads it, and the message still matches (`showsToolResult`).
 */
export function keptToolSource(value: unknown, owner: string, streaming: boolean): ToolSource {
	const twin = streaming ? undefined : savedOutputTwin(asRecord(value).structuredContent);
	return { value: twin ? { ...asRecord(value), structuredContent: twin } : value, owner, streaming };
}

/** The members of a result that its displayed data is built from. */
const RESULT_MEMBERS = ["content", "structuredContent", "details", "usage", "progress"] as const;

/**
 * Whether `tool` already shows the result that the tool-result message `message` carries: the tool finished with the
 * same outcome, from a result (`source`) whose displayed members are the message's own objects. The agent builds the
 * message from the result it has just reported, so normalizing the message again would rebuild the same state. Any
 * difference (a hook that replaced the content, another name, a missing duration) makes it a new result.
 */
export function showsToolResult(
	tool: ApplicationTool | undefined,
	source: ToolSource | undefined,
	message: Record<string, unknown>,
	toolName: string,
): boolean {
	if (!tool || !source || source.streaming || source.owner !== toolName || tool.toolName !== toolName) return false;
	if (tool.status !== (message.isError === true ? "failed" : "completed")) return false;
	if (typeof message.durationMs === "number" && message.durationMs !== tool.durationMs) return false;
	const result = asRecord(source.value);
	if ((result.isError === true) !== (message.isError === true)) return false;
	return RESULT_MEMBERS.every((member) => result[member] === message[member]);
}

/** The largest serialized tool display the transcript keeps inline; a larger one moves to an asset. */
const TOOL_CHARS = 60000;

/** Move an oversized tool result display into an asset and leave a placeholder; smaller data is returned as is. */
export function spillToolData(
	data: Partial<ApplicationTool>,
	id: string,
	assets: ApplicationAssets,
	streaming: boolean,
): Partial<ApplicationTool> {
	if (recordJsonLength(data) <= TOOL_CHARS) return data;
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
	if (recordJsonLength(tool) <= TOOL_CHARS) return tool;
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
