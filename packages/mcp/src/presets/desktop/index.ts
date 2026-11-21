import { accessSync, constants } from "node:fs";
import path from "node:path";
import { envFlag, MCP_DESKTOP_ENV } from "@octocodeai/octocode-common/env";
import { DESKTOP_BIN, DESKTOP_SERVER } from "@octocodeai/octocode-common/mcp-names";
import type { McpServerPreset } from "../../preset.ts";
import { defineDesktopTool } from "./tools.ts";

/**
 * The tools a desktop task uses every time: list a window, read it, launch an app, act on it and quit it by its menu
 * (recorded runs used these nine; `invoke_menu` is declared because a tool called before it is declared fails its first
 * call on argument types, which cost a round and a schema read in three of five runs).
 * Cua Driver 0.30.4 serves 58 tools (about 100,000 characters of descriptions and schemas), so every other tool is left
 * on demand: listed by name and trigger, declared when first loaded or called.
 */
const DESKTOP_CORE_TOOLS: ReadonlySet<string> = new Set([
	"list_windows",
	"get_window_state",
	"verify_state",
	"launch_app",
	"invoke_menu",
	"click",
	"type_text",
	"press_key",
	"hotkey",
]);

/**
 * Driver tools no agent may call: they install software (`install_extension` fetches the AGPL `cua-perception`
 * extension, `install_ffmpeg` a binary) or rewrite Driver's own configuration (`set_config`, telemetry included) or run
 * script in a page (`page`, the legacy tool the typed `browser_*` tools replace). The user does the first three with
 * `cua-driver` itself; the preset removes all four.
 */
const DESKTOP_HIDDEN_TOOLS = ["install_extension", "install_ffmpeg", "set_config", "page"] as const;

/** The server's tools by name, as of Cua Driver 0.30.4; one it adds later is declared like any MCP tool. */
const DESKTOP_RARE_TOOLS = [
	"list_apps",
	"get_desktop_state",
	"scroll",
	"set_value",
	"kill_app",
	"bring_to_front",
	"set_window_frame",
	"double_click",
	"right_click",
	"drag",
	"clipboard_read",
	"clipboard_write",
	"get_screen_size",
	"get_cursor_position",
	"move_cursor",
	"set_agent_cursor_enabled",
	"set_agent_cursor_motion",
	"set_agent_cursor_theme",
	"get_agent_cursor_state",
	"check_permissions",
	"health_report",
	"get_config",
	"set_config",
	"get_accessibility_tree",
	"zoom",
	"page",
	"get_browser_state",
	"browser_prepare",
	"browser_navigate",
	"browser_click",
	"browser_type",
	"browser_dialog",
	"browser_set_input_files",
	"browser_download",
	"browser_pointer",
	"start_recording",
	"stop_recording",
	"get_recording_state",
	"replay_trajectory",
	"install_ffmpeg",
	"start_session",
	"escalate_session",
	"get_session",
	"list_sessions",
	"get_session_state",
	"end_session",
	"check_for_update",
	"install_extension",
	"parse_visual_regions",
].filter((name) => !DESKTOP_CORE_TOOLS.has(name) && !(DESKTOP_HIDDEN_TOOLS as readonly string[]).includes(name));

/** Whether `command` is an executable file in a `PATH` folder (`.exe`, `.cmd` and `.bat` count on Windows). */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	for (const folder of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		for (const extension of extensions) {
			try {
				accessSync(path.join(folder, command + extension), constants.X_OK);
				return true;
			} catch {
				// Not in this folder.
			}
		}
	}
	return false;
}

/** Whether the built-in `desktop` server is enabled here: `cua-driver` is on `PATH` and `OCTOCODE_MCP_DESKTOP` is not `0`. */
export const desktopAvailable = (env: NodeJS.ProcessEnv = process.env): boolean =>
	onPath(DESKTOP_BIN, env) && envFlag(env, MCP_DESKTOP_ENV, true);

/**
 * Cua Driver as the `desktop` MCP server (`cua-driver mcp`, MIT): it inspects and operates native apps on the user's
 * own desktop. Octocode never installs or bundles it, so the server is enabled only while `cua-driver` is on `PATH`
 * (`OCTOCODE_MCP_DESKTOP=0` keeps it off anyway); without the executable it stays listed, disabled, with the install
 * pointer. It is not in the default tool selection (`defaultActive: false`): the `desktop` subagent selects its tools
 * and the main agent delegates to it. Every call that is not declared read-only asks `desktop.control` in every mode
 * (`permission/desktop-mcp.ts`). The launch never passes `--grant existing-profile`; a user's own `desktop` server in
 * `mcp.json` replaces this one.
 */
export function desktopPreset(env: NodeJS.ProcessEnv = process.env): McpServerPreset {
	const installed = onPath(DESKTOP_BIN, env);
	return {
		name: DESKTOP_SERVER,
		config: {
			command: DESKTOP_BIN,
			args: ["mcp"],
			inheritEnv: true,
			defaultActive: false,
			enabled: installed && envFlag(env, MCP_DESKTOP_ENV, true),
			toolExposure: {
				...Object.fromEntries(DESKTOP_RARE_TOOLS.map((tool) => [tool, "onDemand" as const])),
				...Object.fromEntries(DESKTOP_HIDDEN_TOOLS.map((tool) => [tool, "hidden" as const])),
			},
			description: installed
				? "Native desktop apps on this computer: inspect and operate them, with screenshots."
				: `Native desktop apps through Cua Driver. Not installed: ${DESKTOP_BIN} is not on PATH (https://cua.ai/docs/cua-driver/quickstart).`,
		},
		defineTool: defineDesktopTool,
		instructionsOnDemand: true,
	};
}
