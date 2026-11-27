import type { FeatureRecord } from "./features/types.ts";
import { MCP_MANAGE_TOOL_NAME } from "@octocodeai/octocode-common/mcp-names";
import { DEFAULT_TOOL_NAMES } from "./settings-manager.ts";

/**
 * The built-in MCP feature's `mcp` tool. It registers inactive, so `noTools`, the `defaultTools` setting and `--tools`
 * decide it like a built-in tool, instead of it staying active as feature tools do.
 */
const isMcpFeature = (feature: FeatureRecord) => feature.owner === "builtin" && feature.id === "mcp";

export function defaultToolNames(features: readonly FeatureRecord[]): string[] {
	const native = features.find((feature) => feature.owner === "native");
	const names = native ? [] : [...DEFAULT_TOOL_NAMES];
	for (const { definition } of native?.tools.values() ?? []) {
		if (definition.defaultActive !== false && !names.includes(definition.name)) names.push(definition.name);
	}
	const mcp = features.find(isMcpFeature);
	if (mcp?.tools.has(MCP_MANAGE_TOOL_NAME) && !names.includes(MCP_MANAGE_TOOL_NAME)) names.push(MCP_MANAGE_TOOL_NAME);
	return names;
}
