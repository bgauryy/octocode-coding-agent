import type { McpExtensionApi } from "./host/types.ts";
import { registerMcpHost } from "./index.ts";
import { browserPreset } from "./presets/browser/index.ts";
import { recommendedPresets } from "./recommended/index.ts";

export function defaultMcpExtension(api: McpExtensionApi): void {
	registerMcpHost(api, {
		presets: [...recommendedPresets(), browserPreset()],
	});
}
