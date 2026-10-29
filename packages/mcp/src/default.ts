import type { ExtensionAPI } from "../../coding-agent/src/core/extensions/types.ts";
import { registerMcpHost } from "./index.ts";
import { browserPreset } from "./presets/browser/index.ts";
import { octocodePreset } from "./presets/octocode/index.ts";
import { trustedMcpOptions } from "./trust.ts";

export function defaultMcpExtension(api: ExtensionAPI): void {
	registerMcpHost(api, {
		...trustedMcpOptions(api),
		presets: [octocodePreset(() => api.getSkillDirectories()), browserPreset()],
	});
}
