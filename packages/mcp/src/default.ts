import type { McpFeatureApi } from "./host/types.ts";
import { registerMcpHost } from "./index.ts";
import type { McpNativeTools } from "./manage-tool.ts";
import { browserPreset } from "./presets/browser/index.ts";
import { recommendedPresets } from "./recommended/index.ts";

/** The built-in MCP feature. The host passes the native tools its `mcp` tool reads (`McpNativeTools`). */
export function defaultMcpFeature(api: McpFeatureApi, host: { nativeTools?: McpNativeTools } = {}): void {
	registerMcpHost(api, {
		presets: [...recommendedPresets(), browserPreset()],
		...(host.nativeTools ? { nativeTools: host.nativeTools } : {}),
	});
}
