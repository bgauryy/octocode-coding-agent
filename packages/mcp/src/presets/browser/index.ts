import type { McpServerPreset } from "../../preset.ts";
import { defaultServerPreset } from "../default-config.ts";
import { browserLaunch } from "./launch.ts";
import { BROWSER_SERVER } from "@octocodeai/octocode-common/mcp-names";
import { stopOwnedBrowsers } from "./owned.ts";
import { browserGuard } from "./proxy.ts";
import { defineBrowserTool } from "./tools.ts";

/**
 * Octocode's built-in browser: the `@octocodeai/octocode-chrome-devtools` MCP server (isolated Chrome, browser plans,
 * snapshots, extraction, raw CDP and saved evidence). Its data (command, `exposure: "onDemand"`, the
 * `OCTOCODE_MCP_BROWSER` flag, which agents get it) is in `default_mcp_config.json`; this adds the behavior. The main
 * session selects it with every tool on demand: the cached `mcps` block carries one index line per tool, and a tool is
 * declared after the cached prompt on its first call or an `mcp` load, so the prefix stays byte-identical. A user
 * `browser` server in `mcp.json` replaces the launch; control-only overrides (`enabled`, `defaultActive`, `exposure`,
 * `toolExposure`) apply to this default. The Chrome that `open` starts runs behind Octocode's filtering proxy
 * (`./proxy.ts`), which stops on session shutdown (`dispose`), as does a headless Chrome the top session still owns
 * (`./owned.ts`).
 */
export function browserPreset(env: NodeJS.ProcessEnv = process.env): McpServerPreset {
	return {
		...defaultServerPreset(BROWSER_SERVER, env),
		defineTool: defineBrowserTool,
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
