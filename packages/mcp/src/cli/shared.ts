/** Options, argument parsing and connections shared by the `octocode mcp` subcommands. */

import { join } from "node:path";
import chalk from "chalk";
import { hostIdentity, hostTrust } from "../host.ts";
import { findMcpPreset, type McpServerPreset } from "../preset.ts";
import { createServerConnection } from "../connection-factory.ts";
import { expandLaunchTemplates } from "../launch-templates.ts";
import type { McpServerEntry } from "../config.ts";
import { McpServerLog } from "../log.ts";
import type { McpOAuthCredentialStore } from "../oauth.ts";
import { storedProviderToken } from "./provider-token.ts";

export const helpHint = (): string => chalk.dim(`Use "${hostIdentity().appName} mcp --help" for usage.`);

export interface McpCommandOptions {
	presets?: readonly McpServerPreset[];
	cwd: string;
	agentDir: string;
	/** Prepare the host's trust store before a command reads folder trust. Standalone hosts may omit this. */
	prepareTrust?: () => Promise<void>;
	/** Defaults to `mcp-auth.json` in the agent directory. */
	credentials?: McpOAuthCredentialStore;
	/** Defaults to the platform browser. */
	openUrl?: (url: string) => void;
	/** Defaults to console output. */
	log?: (line: string) => void;
	error?: (line: string) => void;
	/** The token of a model provider. Defaults to the stored `/providers` credentials of the agent directory. */
	providerToken?: (provider: string) => Promise<string | undefined>;
	/** Transient launch defaults, applied before the launch templates are expanded. */
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
		prepareLaunch: (entry, cwd) => {
			const preset = findMcpPreset(options.presets, entry.name);
			const projectTrusted = hostTrust().folderTrusted(cwd);
			const prepared = preset?.prepareLaunch?.(entry, cwd, projectTrusted) ?? entry;
			return expandLaunchTemplates(options.prepareLaunch?.(prepared, cwd) ?? prepared, { cwd, projectTrusted });
		},
		log: new McpServerLog(join(options.agentDir, "mcp.log")),
	});
}

/** Short spellings of options. `-l`/`--local` match `octocode install`. */
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
			error(`Unknown option ${arg}.\n${helpHint()}`);
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
