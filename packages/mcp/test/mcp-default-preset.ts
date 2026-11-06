import type { McpServerPreset } from "../src/preset.ts";
import { recommendedPresets } from "../src/recommended/index.ts";

/**
 * The host's default server as production registers it (the first recommended preset, data only: its `${workspace}`
 * and `${researchRoots}` launch templates resolve in the host), minus its `install` block, so a test launches its own
 * fixture process instead of resolving the real package. Install resolution has its own tests (`mcp-install`).
 */
export function defaultPreset(env: NodeJS.ProcessEnv = {}): McpServerPreset {
	const [preset] = recommendedPresets(env);
	if (!preset?.config || "url" in preset.config) throw new Error("no recommended server is registered");
	const { install: _install, ...config } = preset.config;
	return { ...preset, config };
}
