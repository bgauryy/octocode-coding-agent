import type { Extension } from "./extensions/types.ts";
import { MCP_MANAGE_TOOL_NAME } from "../../../mcp/src/servers.ts";
import { DEFAULT_TOOL_NAMES } from "./settings-manager.ts";
import { BUILTIN_PATH_PREFIX } from "./source-info.ts";

export const NATIVE_FEATURE_PATH = "<inline:octocode>";

/**
 * The built-in MCP extension's `mcp` tool. It registers inactive, so `noTools`, the `defaultTools` setting and `--tools`
 * decide it like a built-in tool, instead of it staying active as extension tools do.
 */
const MCP_EXTENSION_PATH = `${BUILTIN_PATH_PREFIX}mcp`;

export function defaultToolNames(extensions: readonly Extension[]): string[] {
	const native = extensions.find((extension) => extension.sourceInfo.path === NATIVE_FEATURE_PATH);
	const names = native ? [] : [...DEFAULT_TOOL_NAMES];
	for (const { definition } of native?.tools.values() ?? []) {
		if (definition.defaultActive !== false && !names.includes(definition.name)) names.push(definition.name);
	}
	const mcp = extensions.find((extension) => extension.sourceInfo.path === MCP_EXTENSION_PATH);
	if (mcp?.tools.has(MCP_MANAGE_TOOL_NAME) && !names.includes(MCP_MANAGE_TOOL_NAME)) names.push(MCP_MANAGE_TOOL_NAME);
	return names;
}
