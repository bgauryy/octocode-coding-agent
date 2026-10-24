import type { ToolCallEvent, ToolInfo } from "../../core/extensions/index.ts";
import { NATIVE_FEATURE_PATH } from "../../core/native-tools.ts";
import { LOCAL_RESEARCH_TOOLS } from "../shared/octocode-tools.ts";

const reads = new Set([...LOCAL_RESEARCH_TOOLS, "archive", "askUser", "web"]);
/** Deliberately closed: shell interpreters, delegation and arbitrary MCP annotations are not read guarantees. */
export function planningRefusal(
	event: Pick<ToolCallEvent, "toolName" | "input">,
	definition?: ToolInfo,
): string | undefined {
	const native = definition?.sourceInfo.path === NATIVE_FEATURE_PATH;
	if (native && reads.has(event.toolName)) return undefined;
	if (event.toolName === "tool_search" && definition?.sourceInfo.path === "builtin:tool-search") return undefined;
	return `Plan mode blocks ${event.toolName}. Use native research tools and questions; only the user can leave with /plan --off or approve the displayed revision.`;
}
