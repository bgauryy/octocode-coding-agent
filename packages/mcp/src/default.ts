import type { ExtensionAPI } from "../../coding-agent/src/core/extensions/types.ts";
import { registerMcpHost } from "./index.ts";
import { browserPreset } from "./presets/browser/index.ts";
import { octocodePreset } from "./presets/octocode/index.ts";
import { trustedMcpOptions } from "./trust.ts";

export function defaultMcpExtension(pi: ExtensionAPI): void {
	registerMcpHost(pi, {
		...trustedMcpOptions(pi),
		presets: [octocodePreset(() => pi.getSkillDirectories()), browserPreset()],
	});
}
