import type { Extension } from "./features/types.ts";
import { MCP_MANAGE_TOOL_NAME } from "../../../common/src/mcp-names.ts";
import { DEFAULT_TOOL_NAMES } from "./settings-manager.ts";

/**
 * The built-in MCP feature's `mcp` tool. It registers inactive, so `noTools`, the `defaultTools` setting and `--tools`
 * decide it like a built-in tool, instead of it staying active as feature tools do.
 */
const isMcpFeature = (extension: Extension) => extension.owner === "builtin" && extension.id === "mcp";

export function defaultToolNames(extensions: readonly Extension[]): string[] {
	const native = extensions.find((extension) => extension.owner === "native");
	const names = native ? [] : [...DEFAULT_TOOL_NAMES];
	for (const { definition } of native?.tools.values() ?? []) {
		if (definition.defaultActive !== false && !names.includes(definition.name)) names.push(definition.name);
	}
	const mcp = extensions.find(isMcpFeature);
	if (mcp?.tools.has(MCP_MANAGE_TOOL_NAME) && !names.includes(MCP_MANAGE_TOOL_NAME)) names.push(MCP_MANAGE_TOOL_NAME);
	return names;
}
