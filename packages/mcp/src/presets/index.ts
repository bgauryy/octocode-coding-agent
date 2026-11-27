import { BROWSER_SERVER, DESKTOP_SERVER } from "@octocodeai/octocode-common/mcp-names";
import type { McpServerPreset } from "../preset.ts";
import { defaultServerNames, defaultServerPreset } from "./default-config.ts";
import { browserPreset } from "./browser/index.ts";
import { desktopPreset } from "./desktop/index.ts";

/** The default servers whose preset adds behavior to their data, by server name. */
const BEHAVIOR: Readonly<Record<string, (env: NodeJS.ProcessEnv) => McpServerPreset>> = {
	[BROWSER_SERVER]: browserPreset,
	[DESKTOP_SERVER]: (env) => desktopPreset(env),
};

/** One default server as Octocode registers it: its data from `default_mcp_config.json` plus its behavior, if any. */
export const builtinPreset = (name: string, env: NodeJS.ProcessEnv = process.env): McpServerPreset =>
	BEHAVIOR[name]?.(env) ?? defaultServerPreset(name, env);

/** Every server Octocode registers itself, in `default_mcp_config.json`'s order. */
export const builtinPresets = (env: NodeJS.ProcessEnv = process.env): McpServerPreset[] =>
	defaultServerNames().map((name) => builtinPreset(name, env));
