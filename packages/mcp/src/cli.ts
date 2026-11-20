import { presetEntries } from "./preset.ts";
import { builtinPresets } from "./presets/index.ts";
/**
 * `octocode mcp`: add, remove, and check MCP servers and sign in to them outside a session. Agents run it
 * through bash to configure servers, verify an `mcp.json` they wrote, and start an OAuth sign-in;
 * the user only approves access in the browser. Running sessions pick up new credentials on their
 * next turn.
 */

import chalk from "chalk";
import { hostIdentity, hostTrust } from "./host.ts";
import { globalMcpConfigPath, projectMcpConfigPath } from "./paths.ts";
import { withPluginServers } from "./cli/plugins.ts";
import { MCP_COMMANDS } from "./cli/commands.ts";
import { add, remove } from "./cli/edit.ts";
import { list } from "./cli/list.ts";
import { login } from "./cli/login.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { createConnection, helpHint, type McpCommandOptions, parseOptions } from "./cli/shared.ts";
import { formatMcpConfigLocations, getMcpConfigLocations, untrustedProjectNote } from "./inspection.ts";
import { loadMcpConfig, updateMcpServerConfig, writableSource } from "./config.ts";
import { McpOAuthCredentialStore } from "./oauth.ts";
import { isMcpExposure, MCP_EXPOSURES } from "./servers.ts";

const help = (): string => `${chalk.bold("Usage:")}
  ${hostIdentity().appName} mcp add <server> [options] -- <command> [args...]
  ${hostIdentity().appName} mcp add <server> [options] --url <url>
  ${hostIdentity().appName} mcp remove <server> [-l]
  ${hostIdentity().appName} mcp exposure <server> <${MCP_EXPOSURES.join("|")}> [-l]
  ${hostIdentity().appName} mcp list [--json]
  ${hostIdentity().appName} mcp tools [server] [tool] [--json]
  ${hostIdentity().appName} mcp config [--json]
  ${hostIdentity().appName} mcp login <server> [--timeout <seconds>]
  ${hostIdentity().appName} mcp logout <server>

Configure and check MCP servers and sign in to OAuth servers without starting a session.
Reads the agent directory's mcp.json and trusted project files:
.pi/mcp.json, .mcp.json, .agents/mcp.json, ${hostIdentity().configDirName}/mcp.json (last wins).

Commands:
${MCP_COMMANDS.map(([name, args, description]) => `  ${`${name} ${args}`.trimEnd().padEnd(26)}${description}`).join("\n")}

Options for configuration commands:
  -l, --local             Write project configuration (exposure requires project trust)

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
  --exposure <mode>       direct (default) or hidden
  --description <text>    What the server offers, shown in the system prompt

Other options:
  --json                  Print the list as JSON
  --timeout <seconds>     Time limit for the whole sign-in (default: 300)`;

const DEFAULT_LOGIN_TIMEOUT_SECONDS = 300;

/** Run `octocode mcp <args>` and return the exit code. */
export async function runMcpCommand(args: string[], given: McpCommandOptions): Promise<number> {
	const options = { ...given, presets: given.presets ?? builtinPresets() };
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));
	const [command, ...rest] = args;
	// Only options before `--` belong to this command: after it they are the server's own arguments.
	const own = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
	if (command === undefined || command === "help" || own.includes("--help") || own.includes("-h")) {
		log(help());
		return 0;
	}

	const projectConfig = projectMcpConfigPath(options.cwd);
	if (command === "add" || command === "remove") {
		return command === "add"
			? add(rest, projectConfig, options, log, error)
			: remove(rest, projectConfig, options, log, error);
	}
	// Project definitions and project controls need the folder to be trusted, as in a session.
	await options.prepareTrust?.();
	const projectTrusted = hostTrust().folderTrusted(options.cwd);
	if (command === "config") {
		const parsed = parseOptions(rest, { json: "flag" }, error);
		if (!parsed) return 1;
		if (parsed.positional.length) {
			error(`Usage: ${hostIdentity().appName} mcp config [--json]`);
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
	const untrustedNote = untrustedProjectNote(options.agentDir, options.cwd, projectTrusted);
	// Plugin servers exist only in a session; `list` and `tools` show them as the session registers them.
	const listed = withPluginServers(loaded, { agentDir: options.agentDir, cwd: options.cwd, projectTrusted });
	const credentials = options.credentials ?? new McpOAuthCredentialStore();

	switch (command) {
		case "tools": {
			const parsed = parseOptions(rest, { json: "flag" }, error);
			if (!parsed) return 1;
			const [server, tool, ...extra] = parsed.positional;
			if (extra.length) {
				error(`Usage: ${hostIdentity().appName} mcp tools [server] [tool] [--json]`);
				return 1;
			}
			if (server && !listed.servers.some((entry) => entry.name === server)) {
				error(`No MCP server named "${server}".${untrustedNote ? ` ${untrustedNote}` : ""}`);
				return 1;
			}
			return list(listed, parsed.values.has("json"), untrustedNote, options, credentials, log, { server, tool });
		}
		case "enable":
		case "disable":
			error(
				`"${hostIdentity().appName} mcp ${command}" moved to the one configuration command: ${hostIdentity().appName} configuration ${command} mcp:${rest.find((word) => !word.startsWith("-")) ?? "<server>"}${rest.includes("--local") || rest.includes("-l") ? " --local" : ""}`,
			);
			return 1;
		case "exposure": {
			const parsed = parseOptions(rest, { local: "flag" }, error);
			if (!parsed) return 1;
			const [name, mode, ...extra] = parsed.positional;
			if (!name || extra.length || !isMcpExposure(mode)) {
				error(`Usage: ${hostIdentity().appName} mcp exposure <server> <${MCP_EXPOSURES.join("|")}> [-l]`);
				return 1;
			}
			const entry = loaded.servers.find((server) => server.name === name);
			if (!entry) {
				error(`No MCP server named "${name}".${untrustedNote ? ` ${untrustedNote}` : ""}`);
				return 1;
			}
			const local = parsed.values.has("local");
			if (local && !projectTrusted) {
				error("Project configuration requires a trusted folder.");
				return 1;
			}
			const projectOverride = entry.override && entry.overrideScope !== "global";
			// Another agent's file is never written: a change becomes an override in Octocode's file of that scope.
			const ownProject = entry.scope === "project" ? writableSource(entry) : undefined;
			const target = local
				? (ownProject ?? loaded.projectConfig ?? projectConfig)
				: projectOverride
					? entry.override!
					: entry.scope === "project"
						? (ownProject ?? loaded.projectConfig ?? projectConfig)
						: (loaded.globalConfig ?? globalMcpConfigPath(options.agentDir));
			try {
				updateMcpServerConfig(target, name, { exposure: mode }, { override: target !== entry.source });
			} catch (failure) {
				error(`Could not update ${target}: ${errorMessage(failure)}`);
				return 1;
			}
			log(`MCP server "${name}": exposure ${mode}. Saved to ${target}.`);
			log(
				`Running sessions keep their current configuration; use /mcp exposure ${name} ${mode}${local ? " --local" : ""} there, or restart.`,
			);
			return 0;
		}
		case "list": {
			const parsed = parseOptions(rest, { json: "flag" }, error);
			if (!parsed) return 1;
			if (parsed.positional.length > 0) {
				error(`Usage: ${hostIdentity().appName} mcp list [--json]\n${helpHint()}`);
				return 1;
			}
			return list(listed, parsed.values.has("json"), untrustedNote, options, credentials, log);
		}
		case "login":
		case "logout": {
			const parsed = parseOptions(rest, command === "login" ? { timeout: "value" } : {}, error);
			if (!parsed) return 1;
			const [name, ...extra] = parsed.positional;
			if (!name || extra.length > 0) {
				error(`Usage: ${hostIdentity().appName} mcp ${command} <server>\n${helpHint()}`);
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
			error(`Unknown mcp command "${command}".\n${helpHint()}`);
			return 1;
	}
}
