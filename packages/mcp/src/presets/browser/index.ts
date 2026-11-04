import { envFlag, MCP_BROWSER_ENV } from "../../../../common/src/env.ts";
import type { McpServerPreset } from "../../preset.ts";
import { browserLaunch } from "./launch.ts";
import { browserCompactOverrides } from "./compact-overrides.ts";
import { BROWSER_BIN, BROWSER_SERVER } from "../../../../common/src/mcp-names.ts";
import { stopOwnedBrowsers } from "./owned.ts";
import { browserGuard } from "./proxy.ts";
import { defineBrowserTool } from "./tools.ts";

/**
 * Octocode's built-in browser: the `@octocodeai/octocode-chrome-devtools` MCP server (isolated Chrome, browser plans,
 * snapshots, extraction, raw CDP and saved evidence). It is not in the default tool selection (`defaultActive: false`):
 * the `browser` subagent selects its tools and the main agent delegates to it, so only that subagent starts the server
 * and carries its file in its cached prompt. A user `browser` server in `mcp.json` replaces the launch; control-only
 * overrides (`enabled`, `defaultActive`, `exposure`, `toolExposure`) apply to this default. `OCTOCODE_MCP_BROWSER=0`
 * leaves the default disabled. The Chrome that `open` starts runs behind Octocode's filtering proxy (`./proxy.ts`),
 * which stops on session shutdown (`dispose`), as does a headless Chrome the top session still owns (`./owned.ts`).
 */
export function browserPreset(env: NodeJS.ProcessEnv = process.env): McpServerPreset {
	return {
		name: BROWSER_SERVER,
		config: {
			command: BROWSER_BIN,
			inheritEnv: true,
			defaultActive: false,
			enabled: envFlag(env, MCP_BROWSER_ENV, true),
			description: "Isolated Chrome for pages that need JavaScript, interaction, screenshots or saved evidence.",
		},
		defineTool: defineBrowserTool,
		compactOverrides: browserCompactOverrides,
		dispose: async (cwd) => {
			await browserGuard().dispose();
			if (cwd) await stopOwnedBrowsers(cwd);
		},
		prepareLaunch(entry, cwd) {
			if (entry.scope !== "default") return entry;
			return { ...entry, config: { ...entry.config, ...browserLaunch(cwd) } };
		},
	};
}
