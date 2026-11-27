import type { McpServerPreset } from "../src/preset.ts";
import { builtinPreset } from "../src/presets/index.ts";

/**
 * The host's research server as production registers it (the `octocode` default, data only: its `${workspace}`
 * and `${researchRoots}` launch templates resolve in the host), minus its `install` block, so a test launches its own
 * fixture process instead of resolving the real package. Install resolution has its own tests (`mcp-install`).
 */
export function defaultPreset(env: NodeJS.ProcessEnv = {}): McpServerPreset {
	const preset = builtinPreset("octocode", env);
	if (!preset.config || "url" in preset.config) throw new Error("the octocode default is not a stdio server");
	const { install: _install, ...config } = preset.config;
	return { ...preset, config };
}
