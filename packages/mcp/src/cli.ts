import { presetEntries } from "./preset.ts";
import { octocodePreset } from "./presets/octocode/index.ts";
/**
 * `pi mcp`: add, remove, and check MCP servers and sign in to them outside a session. Agents run it
 * through bash to configure servers, verify an `mcp.json` they wrote, and start an OAuth sign-in;
 * the user only approves access in the browser. Running sessions pick up new credentials on their
 * next turn.
 */

import { existsSync } from "node:fs";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "../../coding-agent/src/config.ts";
import { globalMcpConfigPath, projectMcpConfigPath, projectMcpConfigPaths } from "./paths.ts";
import { ProjectTrustStore } from "../../coding-agent/src/core/trust-manager.ts";
import { add, remove } from "./cli/edit.ts";
import { list } from "./cli/list.ts";
import { login } from "./cli/login.ts";
import { errorMessage } from "../../coding-agent/src/utils/guards.ts";
import { createConnection, HELP_HINT, type McpCommandOptions, parseOptions } from "./cli/shared.ts";
import { formatMcpConfigLocations, getMcpConfigLocations } from "./inspection.ts";
import { loadMcpConfig, type McpExposure, updateMcpServerConfig } from "./config.ts";
import { McpOAuthCredentialStore } from "./oauth.ts";
import { isMcpExposure, MCP_EXPOSURES } from "./servers.ts";

const HELP = `${chalk.bold("Usage:")}
  ${APP_NAME} mcp add <server> [options] -- <command> [args...]
  ${APP_NAME} mcp add <server> [options] --url <url>
  ${APP_NAME} mcp remove <server> [-l]
  ${APP_NAME} mcp enable|disable <server> [-l]
  ${APP_NAME} mcp exposure <server> <${MCP_EXPOSURES.join("|")}> [-l]
  ${APP_NAME} mcp list [--json]
  ${APP_NAME} mcp tools [server] [tool] [--json]
  ${APP_NAME} mcp config [--json]
  ${APP_NAME} mcp login <server> [--timeout <seconds>]
  ${APP_NAME} mcp logout <server>

Configure and check MCP servers and sign in to OAuth servers without starting a session.
Reads the agent directory's mcp.json and trusted project files:
.pi/mcp.json, .mcp.json, .agents/mcp.json, ${CONFIG_DIR_NAME}/mcp.json (last wins).

Commands:
  add <server>            Add or replace a server in mcp.json
  remove <server>         Remove a server from mcp.json
  enable <server>        Enable a configured server
  disable <server>       Disable a configured server
  exposure <server> <mode> Change how its tools are reached
  list                    Show state, tools, and errors (exits 1 on failure)
  tools [server] [tool]    List tools, or inspect a tool's description and input schema
  config                  Show global/workspace paths and their read order
  login <server>          Sign in through the browser
  logout <server>         Delete the stored OAuth credentials

Options for configuration commands:
  -l, --local             Write project configuration (enable/disable/exposure require project trust)

Options for add:
  --url <url>             Streamable HTTP server URL (instead of a command)
  --env <KEY=VALUE>       Environment variable for a stdio server (repeatable)
  --cwd <dir>             Working directory for a stdio server
  --header <KEY=VALUE>    HTTP header (repeatable)
  --bearer-token-env-var <NAME>
                          Send "Authorization: Bearer \${NAME}"
  --oauth-client-id <id>  Pre-registered OAuth client id
  --oauth-client-secret <secret>
                          OAuth client secret (may be \${NAME} or !command)
  --oauth-callback-port <port>
                          Fixed OAuth callback port
  --oauth-client-name <name>
                          Client name sent when registering with the OAuth server
  --exposure <mode>       auto (default), deferred, direct, or hidden
  --description <text>    What the server offers, shown in the system prompt

Other options:
  --json                  Print the list as JSON
  --timeout <seconds>     Time limit for the whole sign-in (default: 300)`;

const DEFAULT_LOGIN_TIMEOUT_SECONDS = 300;

/** Run `pi mcp <args>` and return the exit code. */
export async function runMcpCommand(args: string[], options: McpCommandOptions): Promise<number> {
	options = { ...options, presets: options.presets ?? [octocodePreset()] };
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || args.includes("--help") || args.includes("-h")) {
		log(HELP);
		return 0;
	}

	const projectConfig = projectMcpConfigPath(options.cwd);
	if (command === "add" || command === "remove") {
		return command === "add"
			? add(rest, projectConfig, options, log, error)
			: remove(rest, projectConfig, options, log, error);
	}
	const projectTrusted = new ProjectTrustStore(options.agentDir).get(options.cwd) === true;
	if (command === "config") {
		const parsed = parseOptions(rest, { json: "flag" }, error);
		if (!parsed) return 1;
		if (parsed.positional.length) {
			error(`Usage: ${APP_NAME} mcp config [--json]`);
			return 1;
		}
		const locations = getMcpConfigLocations(options.agentDir, options.cwd, projectTrusted);
		log(parsed.values.has("json") ? JSON.stringify(locations, null, 2) : formatMcpConfigLocations(locations));
		return 0;
	}
	const loaded = loadMcpConfig({
		agentDir: options.agentDir,
		cwd: options.cwd,
		projectTrusted,
		defaults: presetEntries(options.presets ?? []),
	});
	const untrustedNote =
		!projectTrusted && projectMcpConfigPaths(options.cwd).some(existsSync)
			? `Project MCP configuration is ignored because the project is not trusted. Start ${APP_NAME} in the project to trust it.`
			: undefined;
	const credentials = options.credentials ?? new McpOAuthCredentialStore();

	switch (command) {
		case "tools": {
			const parsed = parseOptions(rest, { json: "flag" }, error);
			if (!parsed) return 1;
			const [server, tool, ...extra] = parsed.positional;
			if (extra.length) {
				error(`Usage: ${APP_NAME} mcp tools [server] [tool] [--json]`);
				return 1;
			}
			if (server && !loaded.servers.some((entry) => entry.name === server)) {
				error(`No MCP server named "${server}".${untrustedNote ? ` ${untrustedNote}` : ""}`);
				return 1;
			}
			return list(loaded, parsed.values.has("json"), untrustedNote, options, credentials, log, { server, tool });
		}
		case "enable":
		case "disable":
		case "exposure": {
			const parsed = parseOptions(rest, { local: "flag" }, error);
			if (!parsed) return 1;
			const [name, mode, ...extra] = parsed.positional;
			if (
				!name ||
				extra.length ||
				(command !== "exposure" && mode !== undefined) ||
				(command === "exposure" && !isMcpExposure(mode))
			) {
				error(
					`Usage: ${APP_NAME} mcp ${command} <server>${command === "exposure" ? ` <${MCP_EXPOSURES.join("|")}>` : ""} [-l]`,
				);
				return 1;
			}
			const entry = loaded.servers.find((server) => server.name === name);
			if (!entry) {
				error(`No MCP server named "${name}".${untrustedNote ? ` ${untrustedNote}` : ""}`);
				return 1;
			}
			const local = parsed.values.has("local");
			if (local && !projectTrusted) {
				error("Project configuration requires a trusted project.");
				return 1;
			}
			const projectOverride = entry.override && entry.overrideScope !== "global";
			const target = local
				? entry.scope === "project"
					? entry.source
					: (loaded.projectConfig ?? projectConfig)
				: projectOverride
					? entry.override!
					: entry.scope === "project"
						? entry.source
						: (loaded.globalConfig ?? globalMcpConfigPath(options.agentDir));
			try {
				updateMcpServerConfig(
					target,
					name,
					command === "exposure" ? { exposure: mode as McpExposure } : { enabled: command === "enable" },
					{ override: target !== entry.source },
				);
			} catch (failure) {
				error(`Could not update ${target}: ${errorMessage(failure)}`);
				return 1;
			}
			log(
				`MCP server "${name}": ${command === "exposure" ? `exposure ${mode}` : command === "enable" ? "enabled" : "disabled"}. Saved to ${target}.`,
			);
			log(
				`Running sessions keep their current configuration; use /mcp ${command} ${name}${mode ? ` ${mode}` : ""}${local ? " --local" : ""} there, or restart.`,
			);
			return 0;
		}
		case "list": {
			const parsed = parseOptions(rest, { json: "flag" }, error);
			if (!parsed) return 1;
			if (parsed.positional.length > 0) {
				error(`Usage: ${APP_NAME} mcp list [--json]\n${HELP_HINT}`);
				return 1;
			}
			return list(loaded, parsed.values.has("json"), untrustedNote, options, credentials, log);
		}
		case "login":
		case "logout": {
			const parsed = parseOptions(rest, command === "login" ? { timeout: "value" } : {}, error);
			if (!parsed) return 1;
			const [name, ...extra] = parsed.positional;
			if (!name || extra.length > 0) {
				error(`Usage: ${APP_NAME} mcp ${command} <server>\n${HELP_HINT}`);
				return 1;
			}
			const entry = loaded.servers.find((server) => server.name === name);
			if (!entry) {
				error(
					`No MCP server named "${name}".${untrustedNote ? ` ${untrustedNote}` : ""} Configured: ${loaded.servers.map((server) => server.name).join(", ") || "none"}.`,
				);
				return 1;
			}
			const connection = createConnection(entry, options, credentials);
			const url = connection.oauthUrl;
			if (!url) {
				error(`MCP server "${name}" does not use OAuth. Only HTTP servers without an Authorization header do.`);
				return 1;
			}
			if (command === "logout") {
				const removed = credentials.remove(name, url);
				log(removed ? `Signed out of MCP server "${name}".` : `No stored credentials for MCP server "${name}".`);
				return 0;
			}
			const timeout = Number(parsed.values.get("timeout") ?? DEFAULT_LOGIN_TIMEOUT_SECONDS);
			if (!Number.isFinite(timeout) || timeout <= 0) {
				error("--timeout must be a positive number of seconds.");
				return 1;
			}
			try {
				return await login(entry, connection, url, timeout * 1000, options, credentials, log, error);
			} finally {
				await connection.close();
			}
		}
		default:
			error(`Unknown mcp command "${command}".\n${HELP_HINT}`);
			return 1;
	}
}
