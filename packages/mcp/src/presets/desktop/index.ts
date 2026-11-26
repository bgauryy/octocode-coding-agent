import os from "node:os";
import path from "node:path";
import { CUA_DRIVER_PATH_ENV } from "@octocodeai/octocode-common/env";
import { findOnPath } from "@octocodeai/octocode-common/find-on-path";
import { DESKTOP_BIN, DESKTOP_SERVER } from "@octocodeai/octocode-common/mcp-names";
import type { McpServerPreset } from "../../preset.ts";
import { defaultServerPreset } from "../default-config.ts";
import { defineDesktopTool } from "./tools.ts";
import { type DriverRunner, takeDriverWarnings } from "./health.ts";

/**
 * The Cua Driver executable to start: the file `OCTOCODE_CUA_DRIVER_PATH` names (an explicit choice, so a wrong value is
 * reported, never replaced by a `PATH` lookup), else `cua-driver` on `PATH`. `problem` says why there is none.
 */
function findDriver(
	env: NodeJS.ProcessEnv,
):
	| { command: string; executable: string; problem?: undefined }
	| { command?: undefined; executable?: undefined; problem: string } {
	const named = env[CUA_DRIVER_PATH_ENV]?.trim();
	if (named) {
		const file = named === "~" || named.startsWith("~/") ? path.join(os.homedir(), named.slice(1)) : named;
		if (!path.isAbsolute(file))
			return { problem: `${CUA_DRIVER_PATH_ENV} must be an absolute path (it is "${named}")` };
		if (findOnPath(file, env)) return { command: file, executable: file };
		return { problem: `${CUA_DRIVER_PATH_ENV} points at ${file}, which is not an executable file` };
	}
	const executable = findOnPath(DESKTOP_BIN, env);
	return executable
		? { command: DESKTOP_BIN, executable: path.resolve(executable) }
		: { problem: `${DESKTOP_BIN} is not on PATH` };
}

/** Whether the built-in `desktop` server is enabled here: a Cua Driver executable is found and `OCTOCODE_MCP_DESKTOP` is not `0`. */
export const desktopAvailable = (env: NodeJS.ProcessEnv = process.env): boolean =>
	desktopPreset(env).config?.enabled === true;

/**
 * Cua Driver as the `desktop` MCP server (`cua-driver mcp`, MIT): it inspects and operates native apps on the user's
 * own desktop. Its data is in `default_mcp_config.json`: the launch, the `OCTOCODE_MCP_DESKTOP` flag, the tool tiers
 * (`toolExposure`: the tools recorded desktop runs used stay declared, every other known tool is on demand, and the four
 * that install software, rewrite Driver's configuration or run page script are hidden) and which agents get it (the
 * `desktop` subagent; the main agent delegates to it, so `defaultActive: false`). This adds the behavior: Octocode never
 * installs or bundles Driver, so the server is enabled only while an executable is found: the file
 * `OCTOCODE_CUA_DRIVER_PATH` names, else `cua-driver` on `PATH` (the flag at `0` keeps it off anyway); without the
 * executable it stays listed, disabled, with the install pointer. Every call that is not declared read-only asks `desktop.control` in every mode
 * (`permission/desktop-mcp.ts`). The launch never passes `--grant existing-profile`; a user's own `desktop` server in
 * `mcp.json` replaces this one.
 */
export function desktopPreset(env: NodeJS.ProcessEnv = process.env, runner?: DriverRunner): McpServerPreset {
	const driver = findDriver(env);
	const preset = defaultServerPreset(DESKTOP_SERVER, env);
	const data = preset.config;
	if (!data || !("command" in data)) throw new Error(`default MCP server "${DESKTOP_SERVER}" must be a stdio server`);
	const flagOn = data.enabled !== false;
	return {
		...preset,
		config: {
			...data,
			command: driver.command ?? data.command,
			enabled: driver.command !== undefined && flagOn,
			// The model reads this line (the `<mcps>` block), so it stays plain; warnings for the user go through `takeWarnings`.
			...(driver.command
				? {}
				: {
						description: `Native desktop apps through Cua Driver. Not installed: ${driver.problem} (https://cua.ai/docs/cua-driver/quickstart).`,
					}),
		},
		defineTool: defineDesktopTool,
		startsOutsideServer: "Starting it starts the Cua Driver app, which keeps running",
		// Once per process, and only for a server that will run: a Driver older than the recorded floor, or a missing macOS permission (which otherwise surfaces as a closed connection). Shown to the user, never the model.
		takeWarnings: () => (driver.executable && flagOn ? takeDriverWarnings(driver.executable, runner) : []),
	};
}
