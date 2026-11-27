/** `octocode mcp add` and `octocode mcp remove`: edit the global or project `mcp.json`. */

import { hostIdentity, hostTrust } from "../host.ts";
import { globalMcpConfigPath } from "../paths.ts";
import { validateMcpServerConfig } from "../servers.ts";
import { type McpServerConfig } from "@octocodeai/octocode-contracts/mcp-server";
import { addMcpServerConfig, loadMcpConfig, removeMcpServerConfig } from "../config.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { reviewBeforeAdding } from "../review-first.ts";
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

/** A server definition read from `add` arguments, off and unassigned: what `octocode mcp add` and `/settings add mcp` write. */
export interface ParsedMcpAdd {
	name: string;
	/** Validated definition: `{ url, headers?, oauth? }` or `{ command, args?, env?, cwd? }`, with `exposure` and `description`. */
	config: McpServerConfig;
	/** `--local` was given: write the project file. */
	project: boolean;
}

/** Parse `<server> [options] (--url <url> | -- <command> [args...])`; reports why and returns undefined when it is wrong. */
export function parseMcpAddArgs(
	args: string[],
	error: (line: string) => void,
	usage = `Usage: ${hostIdentity().appName} mcp add <server> [options] (--url <url> | -- <command> [args...])\n${helpHint()}`,
): ParsedMcpAdd | undefined {
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
	if (!parsed) return undefined;
	const { positional, values, lists } = parsed;
	const [name, ...command] = positional;
	const url = values.get("url");
	if (!name || (url === undefined) === (command.length === 0)) {
		error(usage);
		return undefined;
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
		return undefined;
	}

	let config: Record<string, unknown>;
	if (typeof url === "string") {
		const headers = parsePairs("header", lists.get("header"), error);
		if (!headers) return undefined;
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
		if (!env) return undefined;
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
	// A new definition is saved off and unassigned, as Add MCP saves it (`saveMcpDefinition`): it stays off until the
	// user approves its launch in the security review and switches it on.
	config.enabled = false;
	config.defaultActive = false;
	const validated = validateMcpServerConfig(name, config);
	if (typeof validated === "string") {
		error(validated);
		return undefined;
	}
	return { name, config: validated, project: values.has("local") };
}

export async function add(
	args: string[],
	projectConfig: string,
	options: McpCommandOptions,
	log: (line: string) => void,
	error: (line: string) => void,
): Promise<number> {
	const parsed = parseMcpAddArgs(args, error);
	if (!parsed) return 1;
	const { name, project } = parsed;
	const validated = parsed.config;
	if (project) await options.prepareTrust?.();

	const path = project ? projectConfig : globalMcpConfigPath(options.agentDir);
	const scope = project ? "project" : "global";
	let replaced: boolean;
	try {
		reviewBeforeAdding(options);
		replaced = addMcpServerConfig(path, name, validated);
	} catch (addError) {
		error(`Could not update ${path}: ${errorMessage(addError)}`);
		return 1;
	}
	const app = hostIdentity().appName;
	log(
		`Saved ${scope} MCP server "${name}" off and unassigned in ${path}${replaced ? " (replacing the earlier one)" : ""}.`,
	);
	log(
		`Nothing was started. Review and approve it (\`${app} security show mcp:${name}\`, then \`${app} security approve mcp:${name}\`), then switch it on: \`${app} configuration enable mcp:${name}\`, and choose its agents in /mcp.`,
	);
	if (project && !hostTrust().folderTrusted(options.cwd)) {
		log(
			`The folder is not trusted, so ${path} is ignored until you trust it: run \`${hostIdentity().appName} trust add\` in it, or start ${hostIdentity().appName} there.`,
		);
	}
	// HTTP servers without an Authorization header may use OAuth.
	const mayNeedSignIn =
		"url" in validated &&
		!Object.keys(validated.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
	if (mayNeedSignIn) log(`If it requires sign-in: ${app} mcp login ${name}`);
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
