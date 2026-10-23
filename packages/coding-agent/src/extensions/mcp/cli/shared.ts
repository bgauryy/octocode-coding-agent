/** Options, argument parsing and connections shared by the `pi mcp` subcommands. */

import { join } from "node:path";
import chalk from "chalk";
import { APP_NAME } from "../../../config.ts";
import { prepareOctocodeSkillLaunch } from "../../../octocode/mcp/skill-paths.ts";
import { createServerConnection } from "../connection-factory.ts";
import type { McpServerEntry } from "../config.ts";
import { McpServerLog } from "../log.ts";
import type { McpOAuthCredentialStore } from "../oauth.ts";
import { storedProviderToken } from "./provider-token.ts";

export const HELP_HINT = chalk.dim(`Use "${APP_NAME} mcp --help" for usage.`);

export interface McpCommandOptions {
	cwd: string;
	agentDir: string;
	/** Defaults to `mcp-auth.json` in the agent directory. */
	credentials?: McpOAuthCredentialStore;
	/** Defaults to the platform browser. */
	openUrl?: (url: string) => void;
	/** Defaults to console output. */
	log?: (line: string) => void;
	error?: (line: string) => void;
	/** The token of a pi provider. Defaults to the stored `/login` credentials of the agent directory. */
	providerToken?: (provider: string) => Promise<string | undefined>;
	/** Defaults to the roots a session gives the local `octocode` server, without skill directories. */
	prepareLaunch?: (entry: McpServerEntry, cwd: string) => McpServerEntry;
}

const providerTokens = new WeakMap<McpCommandOptions, NonNullable<McpCommandOptions["providerToken"]>>();

export function createConnection(
	entry: McpServerEntry,
	options: McpCommandOptions,
	credentials: McpOAuthCredentialStore,
) {
	let providerToken = options.providerToken ?? providerTokens.get(options);
	if (!providerToken) {
		providerToken = storedProviderToken(options.agentDir);
		providerTokens.set(options, providerToken);
	}
	return createServerConnection({
		entry,
		cwd: options.cwd,
		credentials,
		providerToken,
		prepareLaunch: options.prepareLaunch ?? ((launch, cwd) => prepareOctocodeSkillLaunch(launch, cwd, [])),
		log: new McpServerLog(join(options.agentDir, "mcp.log")),
	});
}

/** Short spellings of options. `-l`/`--local` match `pi install`. */
const OPTION_ALIASES = new Map([["-l", "--local"]]);

interface ParsedOptions {
	positional: string[];
	values: Map<string, string | true>;
	/** Values of `list` options, in order. */
	lists: Map<string, string[]>;
}

/**
 * Parse `--name value` options; returns undefined and reports unknown ones. `--` ends the options,
 * as does reaching `maxPositionals` positional arguments: the remaining arguments are positional,
 * so a command's own options (`add <server> <command> --flag`) are passed through.
 */
export function parseOptions(
	args: string[],
	known: Record<string, "flag" | "value" | "list">,
	error: (line: string) => void,
	maxPositionals = Number.POSITIVE_INFINITY,
): ParsedOptions | undefined {
	const positional: string[] = [];
	const values = new Map<string, string | true>();
	const lists = new Map<string, string[]>();
	for (let index = 0; index < args.length; index++) {
		const arg = OPTION_ALIASES.get(args[index]) ?? args[index];
		if (arg === "--" || positional.length >= maxPositionals) {
			positional.push(...args.slice(arg === "--" ? index + 1 : index));
			break;
		}
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const name = arg.slice(2);
		const kind = known[name];
		if (!kind) {
			error(`Unknown option ${arg}.\n${HELP_HINT}`);
			return undefined;
		}
		if (kind === "flag") {
			values.set(name, true);
			continue;
		}
		const value = args[++index];
		if (value === undefined) {
			error(`${arg} needs a value.`);
			return undefined;
		}
		if (kind === "list") lists.set(name, [...(lists.get(name) ?? []), value]);
		else values.set(name, value);
	}
	return { positional, values, lists };
}
