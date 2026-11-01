/** `octocode mcp add` and `octocode mcp remove`: edit the global or project `mcp.json`. */

import { hostIdentity, hostTrust } from "../host.ts";
import { globalMcpConfigPath } from "../paths.ts";
import { validateMcpServerConfig } from "../servers.ts";
import { addMcpServerConfig, loadMcpConfig, removeMcpServerConfig } from "../config.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { helpHint, type McpCommandOptions, parseOptions } from "./shared.ts";

/** Parse `KEY=VALUE` pairs of a repeatable option into a record. */
function parsePairs(option: string, pairs: string[] | undefined, error: (line: string) => void) {
	if (!pairs) return {};
	const record: Record<string, string> = {};
	for (const pair of pairs) {
		const separator = pair.indexOf("=");
		if (separator <= 0) {
			error(`--${option} expects KEY=VALUE, got "${pair}".`);
			return undefined;
		}
		record[pair.slice(0, separator)] = pair.slice(separator + 1);
	}
	return record;
}

export function add(
	args: string[],
	projectConfig: string,
	options: McpCommandOptions,
	log: (line: string) => void,
	error: (line: string) => void,
): number {
	const usage = `Usage: ${hostIdentity().appName} mcp add <server> [options] (--url <url> | -- <command> [args...])\n${helpHint()}`;
	const parsed = parseOptions(
		args,
		{
			local: "flag",
			url: "value",
			env: "list",
			cwd: "value",
			header: "list",
			"bearer-token-env-var": "value",
			"oauth-client-id": "value",
			"oauth-client-secret": "value",
			"oauth-callback-port": "value",
			"oauth-client-name": "value",
			exposure: "value",
			description: "value",
		},
		error,
		2,
	);
	if (!parsed) return 1;
	const { positional, values, lists } = parsed;
	const [name, ...command] = positional;
	const url = values.get("url");
	if (!name || (url === undefined) === (command.length === 0)) {
		error(usage);
		return 1;
	}
	const value = (option: string) => {
		const found = values.get(option);
		return typeof found === "string" ? found : undefined;
	};
	const exposure = value("exposure");
	const httpOnly = [
		"header",
		"bearer-token-env-var",
		"oauth-client-id",
		"oauth-client-secret",
		"oauth-callback-port",
		"oauth-client-name",
	];
	const stdioOnly = ["env", "cwd"];
	const misplaced = (url === undefined ? httpOnly : stdioOnly).find(
		(option) => values.has(option) || lists.has(option),
	);
	if (misplaced) {
		error(`--${misplaced} only applies to ${url === undefined ? "HTTP servers (--url)" : "stdio servers"}.`);
		return 1;
	}

	let config: Record<string, unknown>;
	if (typeof url === "string") {
		const headers = parsePairs("header", lists.get("header"), error);
		if (!headers) return 1;
		const bearer = value("bearer-token-env-var");
		if (bearer !== undefined) headers.Authorization = `Bearer \${${bearer}}`;
		const port = value("oauth-callback-port");
		const oauth = {
			...(value("oauth-client-id") === undefined ? {} : { clientId: value("oauth-client-id") }),
			...(value("oauth-client-secret") === undefined ? {} : { clientSecret: value("oauth-client-secret") }),
			...(port === undefined ? {} : { callbackPort: Number(port) }),
			...(value("oauth-client-name") === undefined ? {} : { clientName: value("oauth-client-name") }),
		};
		config = {
			url,
			...(Object.keys(headers).length > 0 ? { headers } : {}),
			...(Object.keys(oauth).length > 0 ? { oauth } : {}),
		};
	} else {
		const env = parsePairs("env", lists.get("env"), error);
		if (!env) return 1;
		const [executable, ...commandArgs] = command;
		config = {
			command: executable,
			...(commandArgs.length > 0 ? { args: commandArgs } : {}),
			...(Object.keys(env).length > 0 ? { env } : {}),
			...(value("cwd") === undefined ? {} : { cwd: value("cwd") }),
		};
	}
	if (exposure !== undefined) config.exposure = exposure;
	const description = value("description");
	if (description !== undefined) config.description = description;
	const validated = validateMcpServerConfig(name, config);
	if (typeof validated === "string") {
		error(validated);
		return 1;
	}

	const project = values.has("local");
	const path = project ? projectConfig : globalMcpConfigPath(options.agentDir);
	const scope = project ? "project" : "global";
	let replaced: boolean;
	try {
		replaced = addMcpServerConfig(path, name, validated);
	} catch (addError) {
		error(`Could not update ${path}: ${errorMessage(addError)}`);
		return 1;
	}
	log(`${replaced ? "Replaced" : "Added"} ${scope} MCP server "${name}" in ${path}.`);
	if (project && !hostTrust().directoryTrusted(options.agentDir, options.cwd)) {
		log(
			`The project is not trusted, so ${path} is ignored until you start ${hostIdentity().appName} in the project and trust it.`,
		);
	}
	// HTTP servers without an Authorization header may use OAuth.
	const mayNeedSignIn =
		"url" in validated &&
		!Object.keys(validated.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
	log(
		`Check it with: ${hostIdentity().appName} mcp list${mayNeedSignIn ? `. If it requires sign-in: ${hostIdentity().appName} mcp login ${name}` : ""}`,
	);
	return 0;
}

export function remove(
	args: string[],
	projectConfig: string,
	options: McpCommandOptions,
	log: (line: string) => void,
	error: (line: string) => void,
): number {
	const parsed = parseOptions(args, { local: "flag" }, error);
	if (!parsed) return 1;
	const [name, ...extra] = parsed.positional;
	if (!name || extra.length > 0) {
		error(`Usage: ${hostIdentity().appName} mcp remove <server> [-l]\n${helpHint()}`);
		return 1;
	}
	const project = parsed.values.has("local");
	const globalConfig = globalMcpConfigPath(options.agentDir);
	const path = project ? projectConfig : globalConfig;
	const scope = project ? "project" : "global";
	let removed: boolean;
	try {
		removed = removeMcpServerConfig(path, name);
	} catch (removeError) {
		error(`Could not update ${path}: ${errorMessage(removeError)}`);
		return 1;
	}
	if (removed) {
		log(`Removed ${scope} MCP server "${name}" from ${path}.`);
		return 0;
	}
	const other = loadMcpConfig({ agentDir: options.agentDir, cwd: options.cwd, projectTrusted: true }).servers.find(
		(server) => server.name === name && server.scope !== scope,
	);
	error(
		`No ${scope} MCP server named "${name}" in ${path}.${other ? ` It is defined in ${other.source}${other.scope === "project" ? "; use --local" : "; omit --local"}.` : ""}`,
	);
	return 1;
}
