import type { McpFeatureApi } from "./host/types.ts";
import { registerMcpHost } from "./index.ts";
import type { McpFeatureOptions } from "./options.ts";
import { browserPreset } from "./presets/browser/index.ts";
import { recommendedPresets } from "./recommended/index.ts";

/**
 * The built-in MCP feature. The host passes the native tools its `mcp` tool reads (`McpNativeTools`) and whether it runs
 * a session on a model lean (`McpFeatureOptions.leanSession`).
 */
export function defaultMcpFeature(
	api: McpFeatureApi,
	host: Pick<McpFeatureOptions, "nativeTools" | "leanSession"> = {},
): void {
	registerMcpHost(api, {
		presets: [...recommendedPresets(), browserPreset()],
		...(host.nativeTools ? { nativeTools: host.nativeTools } : {}),
		...(host.leanSession ? { leanSession: host.leanSession } : {}),
	});
}
