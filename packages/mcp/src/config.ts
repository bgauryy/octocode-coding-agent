/**
 * MCP server configuration.
 *
 * Servers are read from global fallbacks through the writable agent directory, then trusted project
 * paths. Each uses the `mcpServers` shape shared by other MCP clients. Later entries replace earlier
 * transports with the same namespace; conflicting spellings within one file are refused. A replacement without its own
 * `description` keeps the replaced entry's (a built-in server's, say), since the prompt's purpose line comes from it.
 * A replacement of a default entry's name without its own `roles` keeps the roles of the entry it replaces, so the
 * native features still find that name's research tools; `"roles": {}` clears them. A local (stdio) replacement of a
 * default entry's name also keeps each `env` value of that default entry it does not set itself (the built-in
 * `octocode` entry's workspace and research roots, say); only the default's values pass, never another file's.
 *
 * An entry without `command`, `url`, or `type` overrides only `enabled`, `defaultActive`, `exposure`,
 * `toolExposure` of an earlier server with the same namespace, for example to turn it off in one project:
 * `{ "mcpServers": { "internal-tools": { "enabled": false } } }`. The rest of the global entry is kept,
 * including credentials the project could not set itself.
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
 *     "sentry": { "url": "https://mcp.sentry.dev/mcp" }
 *   }
 * }
 * ```
 *
 * HTTP servers without an `Authorization` header use OAuth when they answer 401 (sign in with `/mcp`).
 * `"auth": { "provider": "<provider>" }` sends the token of a `/providers` provider instead. Project files
 * cannot use it, so a repository cannot pick where the credential goes.
 *
 */

import { hostReview, hostVendors } from "./host.ts";
import { readMcpConfigFile } from "./config-read.ts";
import { isMcpOverride } from "./config-write.ts";
import {
	FOREIGN_MCP_VENDORS,
	globalMcpConfigPath,
	type McpConfigFile,
	type McpConfigVendor,
	mcpConfigFiles,
	projectMcpConfigPath,
} from "./paths.ts";
import { mcpLaunchIdentity } from "./launch-identity.ts";
import { validateMcpServerConfig } from "./servers.ts";
import type { McpServerConfig } from "@octocodeai/octocode-contracts/mcp-server";
import { mcpNamespace } from "@octocodeai/octocode-common/mcp-names";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

export type {
	McpExposure,
	McpHttpServerConfig,
	McpOAuthConfig,
	McpServerConfig,
} from "@octocodeai/octocode-contracts/mcp-server";
export { getMcpToolExposure } from "./servers.ts";
export {
	addMcpServerConfig,
	applyMcpServerPatch,
	type McpServerConfigPatch,
	removeMcpServerConfig,
	updateMcpServerConfig,
} from "./config-write.ts";

export interface McpServerEntry {
	name: string;
	config: McpServerConfig;
	/** Config file that defined the entry, or the path of the feature that registered it. */
	source: string;
	/**
	 * The global or the project `mcp.json`, or `feature` for servers registered with
	 * `api.mcpServers.register()`. Changes to feature servers are not saved.
	 */
	scope?: "global" | "project" | "feature" | "default";
	/** Latest `mcp.json` overriding this server's `enabled`, `defaultActive`, `exposure` or `toolExposure`. */
	override?: string;
	overrideScope?: "global" | "project";
	/** The harness whose file defined the entry (`claude`, `codex`, `cursor`, ...); absent for defaults and features. */
	vendor?: McpConfigVendor;
	/** Off until the user checks and approves this exact entry (`/security`); never set on a built-in entry. */
	withheld?: true;
}

/** The file `/mcp` may write for this entry: none for another agent's file, which only an override can change. */
export const writableSource = (entry: McpServerEntry): string | undefined =>
	entry.vendor && FOREIGN_MCP_VENDORS.has(entry.vendor) ? undefined : entry.source;

export interface LoadedMcpConfig {
	servers: McpServerEntry[];
	errors: string[];
	/** Writable global configuration; fallback files are read-only defaults. */
	globalConfig?: string;
	/** The project `mcp.json` when the project is trusted, where `/mcp` saves project overrides. */
	projectConfig?: string;
}

const OVERRIDE_KEYS = ["enabled", "defaultActive", "exposure", "toolExposure"];

interface McpConfigState {
	servers: Map<string, McpServerEntry>;
	errors: string[];
	/** The default entries, by namespace. */
	defaults: ReadonlyMap<string, McpServerEntry>;
	/** Namespaces defined only in files of vendors that are off: an override of one is kept aside, not an error. */
	switchedOff: Set<string>;
}

/**
 * `config` with what it inherits from the entry it replaces: the description, and for a default entry's name the roles,
 * when it sets none, and the default entry's launch `env` values it does not set, when both are local (stdio).
 */
function inheritFromReplaced(
	config: McpServerConfig,
	replaced: McpServerEntry | undefined,
	defaultEntry: McpServerEntry | undefined,
): McpServerConfig {
	const description = config.description === undefined ? replaced?.config.description : undefined;
	const roles = config.roles === undefined && defaultEntry ? replaced?.config.roles : undefined;
	const defaultEnv = defaultEntry && !("url" in defaultEntry.config) ? defaultEntry.config.env : undefined;
	const env = defaultEnv && !("url" in config) ? { ...defaultEnv, ...config.env } : undefined;
	return {
		...config,
		...(description === undefined ? {} : { description }),
		...(roles === undefined ? {} : { roles: structuredClone(roles) }),
		...(env === undefined ? {} : { env }),
	};
}

/**
 * What one config file holds, for listing: each server name, whether the entry only overrides another server, and the
 * launch identity of a valid definition (what `dropSameLaunchForeign` compares).
 */
export function listMcpFileEntries(
	file: McpConfigFile,
	cwd: string,
): { entries: { name: string; override: boolean; launch?: string }[]; error?: string } {
	const read = readMcpConfigFile(file, cwd);
	if (!read) return { entries: [] };
	if ("error" in read) return { entries: [], error: read.error };
	const foreign = FOREIGN_MCP_VENDORS.has(file.vendor);
	return {
		entries: Object.entries(read.servers).map(([name, value]) => {
			const override = !foreign && isRecord(value) && isMcpOverride(value);
			const config = override ? undefined : validateMcpServerConfig(name, value);
			return {
				name,
				override,
				...(config && typeof config !== "string" ? { launch: mcpLaunchIdentity(config, cwd) } : {}),
			};
		}),
		...(read.errors.length ? { error: read.errors.join("; ") } : {}),
	};
}

function readConfigFile(file: McpConfigFile, cwd: string, state: McpConfigState): void {
	const { servers, errors } = state;
	const { path, scope } = file;
	const read = readMcpConfigFile(file, cwd);
	if (!read) return;
	if ("error" in read) {
		errors.push(read.error);
		return;
	}
	errors.push(...read.errors);
	// Another agent's file defines servers only: it never overrides, and never replaces a default or an Octocode-format
	// file's server of the same name (that one wins whole; discovery lists the other as shadowed).
	const foreign = FOREIGN_MCP_VENDORS.has(file.vendor);
	const names = new Map<string, string>();
	for (const [name, value] of Object.entries(read.servers)) {
		const namespace = mcpNamespace(name);
		const clash = names.get(namespace);
		if (clash && clash !== name) {
			errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
			continue;
		}
		const held = servers.get(namespace);
		if (foreign && held && !(held.vendor && FOREIGN_MCP_VENDORS.has(held.vendor))) continue;
		if (!foreign && isRecord(value) && isMcpOverride(value)) {
			const base = servers.get(namespace);
			const extra = Object.keys(value).filter((key) => !OVERRIDE_KEYS.includes(key));
			if (!base && state.switchedOff.has(namespace)) continue;
			if (!base) {
				// An override has neither "command" nor "url", so validation returns the reason it is incomplete.
				const invalid = validateMcpServerConfig(name, value);
				errors.push(
					scope === "project" || typeof invalid !== "string"
						? `${path}: server "${name}" needs "command" or "url", or a global server to override`
						: `${path}: ${invalid}`,
				);
			} else if (extra.length > 0) {
				errors.push(`${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`);
			} else {
				const config = validateMcpServerConfig(name, { ...base.config, ...value });
				if (typeof config === "string") errors.push(`${path}: ${config}`);
				else {
					servers.set(namespace, { ...base, name, config, override: path, overrideScope: scope });
					names.set(namespace, name);
				}
			}
			continue;
		}
		const config = validateMcpServerConfig(name, value);
		if (typeof config === "string") {
			errors.push(`${path}: ${config}`);
			continue;
		}
		if (scope === "project" && "url" in config && config.auth) {
			errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
			continue;
		}
		// The purpose describes the server under that name (the built-in's, say), so a replacement without its own keeps it;
		// a default name's roles tell native features which tools read and search, so they stay unless the entry sets roles,
		// and its launch env (workspace, research roots) stays under each key the entry leaves unset.
		servers.set(namespace, {
			name,
			config: inheritFromReplaced(config, servers.get(namespace), state.defaults.get(namespace)),
			source: path,
			scope,
			vendor: file.vendor,
		});
		names.set(namespace, name);
	}
}

/**
 * A foreign file's server that launches what another loaded server already launches (under another name) is shadowed
 * like a same-name one: an Octocode-format or default server always wins, and of identical foreign servers the first stays.
 */
function dropSameLaunchForeign(servers: McpServerEntry[], cwd: string): McpServerEntry[] {
	const isForeign = (entry: McpServerEntry) => Boolean(entry.vendor && FOREIGN_MCP_VENDORS.has(entry.vendor));
	const taken = new Set(
		servers.filter((entry) => !isForeign(entry)).map((entry) => mcpLaunchIdentity(entry.config, cwd)),
	);
	return servers.filter((entry) => {
		if (!isForeign(entry)) return true;
		const identity = mcpLaunchIdentity(entry.config, cwd);
		if (taken.has(identity)) return false;
		taken.add(identity);
		return true;
	});
}

/** The names a file of a vendor that is off defines, so an override of one stays quiet. */
function noteSwitchedOff(file: McpConfigFile, cwd: string, state: McpConfigState): void {
	const read = readMcpConfigFile(file, cwd);
	if (read && !("error" in read))
		for (const name of Object.keys(read.servers)) state.switchedOff.add(mcpNamespace(name));
}

/**
 * Load global and (when trusted) project MCP configuration from every file `mcpConfigFiles` lists whose vendor is on
 * (the host's `vendorSwitch`, read now, so a reload sees the current settings). Disabled servers are included with
 * `enabled: false`, so they can be enabled again.
 */
export function loadMcpConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	defaults?: readonly McpServerEntry[];
}): LoadedMcpConfig {
	const state: McpConfigState = {
		servers: new Map((options.defaults ?? []).map((entry) => [mcpNamespace(entry.name), structuredClone(entry)])),
		errors: [],
		defaults: new Map((options.defaults ?? []).map((entry) => [mcpNamespace(entry.name), structuredClone(entry)])),
		switchedOff: new Set(),
	};
	const { agentDir, cwd, projectTrusted } = options;
	const vendorEnabled = hostVendors().vendorSwitch({ agentDir, cwd, projectTrusted });
	const codexHome = hostVendors().codexHome();
	if ("error" in codexHome && vendorEnabled("codex", "global"))
		state.errors.push(`Codex MCP servers were not loaded: ${codexHome.error}`);
	const globalConfig = globalMcpConfigPath(agentDir);
	const projectConfig = projectTrusted ? projectMcpConfigPath(cwd) : undefined;
	for (const file of mcpConfigFiles(agentDir, cwd)) {
		if (file.scope === "project" && !projectTrusted) continue;
		if (vendorEnabled(file.vendor, file.scope)) readConfigFile(file, cwd, state);
		else noteSwitchedOff(file, cwd, state);
	}
	const servers = dropSameLaunchForeign([...state.servers.values()], cwd);
	const off = hostReview()?.withheld(
		servers.filter((entry) => entry.scope !== "default"),
		cwd,
	);
	if (off?.size)
		for (const entry of servers) if (entry.scope !== "default" && off.has(entry.name)) entry.withheld = true;
	return {
		servers,
		errors: state.errors,
		globalConfig,
		...(projectConfig ? { projectConfig } : {}),
	};
}
