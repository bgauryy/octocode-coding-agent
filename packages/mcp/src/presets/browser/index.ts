import { envFlag, MCP_BROWSER_ENV } from "../../../../coding-agent/src/octocode/shared/env.ts";
import type { McpServerPreset } from "../../preset.ts";
import { browserLaunch } from "./launch.ts";
import { BROWSER_BIN, BROWSER_SERVER } from "./names.ts";
import { browserGuard } from "./proxy.ts";
import { defineBrowserTool } from "./tools.ts";

/**
 * Octocode's built-in browser: the `@octocodeai/octocode-chrome-devtools` MCP server (isolated Chrome, browser plans,
 * snapshots, extraction, raw CDP and saved evidence). Its tools defer behind tool search when the model loads tools
 * natively, so they cost no prompt space until a task needs a browser. A user `browser` server in `mcp.json` replaces
 * the launch; control-only overrides (`enabled`, `exposure`, `toolExposure`) apply to this default. `OCTOCODE_MCP_BROWSER=0`
 * leaves the default disabled (a subagent that cannot use browser tools starts no browser server). The Chrome that
 * `open` starts runs behind Octocode's filtering proxy (`./proxy.ts`), which stops on session shutdown (`dispose`).
 */
export function browserPreset(env: NodeJS.ProcessEnv = process.env): McpServerPreset {
	return {
		name: BROWSER_SERVER,
		config: { command: BROWSER_BIN, inheritEnv: true, exposure: "auto", enabled: envFlag(env, MCP_BROWSER_ENV, true) },
		preferDeferred: true,
		defineTool: defineBrowserTool,
		dispose: () => browserGuard().dispose(),
		prepareLaunch(entry, cwd) {
			if (entry.scope !== "default") return entry;
			return { ...entry, config: { ...entry.config, ...browserLaunch(cwd) } };
		},
	};
}
