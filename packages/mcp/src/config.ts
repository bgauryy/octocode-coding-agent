/**
 * MCP server configuration.
 *
 * Servers are read from global fallbacks through the writable agent directory, then trusted project
 * paths. Each uses the `mcpServers` shape shared by other MCP clients. Later entries replace earlier
 * transports with the same namespace; conflicting spellings within one file are refused. A replacement without its own
 * `description` keeps the replaced entry's (a built-in server's, say), since the prompt's purpose line comes from it.
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
 * `"auth": { "provider": "<provider>" }` sends the token of a `/login` provider instead. Project files
 * cannot use it, so a repository cannot pick where the credential goes.
 *
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { globalMcpConfigPath, globalMcpConfigPaths, projectMcpConfigPaths, projectMcpConfigPath } from "./paths.ts";
import { DEFAULT_MCP_EXPOSURE, type McpExposure, type McpServerConfig, validateMcpServerConfig } from "./servers.ts";
import { mcpNamespace } from "../../common/src/mcp-names.ts";
import { hasJsonComments, stripJsonComments } from "../../common/src/json.ts";
import { stripBom } from "../../common/src/text.ts";
import { atomicWriteFileSync } from "../../common/src/atomic-file.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";

export type { McpExposure, McpHttpServerConfig, McpOAuthConfig, McpServerConfig } from "./servers.ts";
export { getMcpToolExposure } from "./servers.ts";

export interface McpServerEntry {
	name: string;
	config: McpServerConfig;
	/** Config file that defined the entry, or the path of the extension that registered it. */
	source: string;
	/**
	 * The global or the project `mcp.json`, or `extension` for servers registered with
	 * `api.registerMcpServer()`. Changes to extension servers are not saved.
	 */
	scope?: "global" | "project" | "extension" | "default";
	/** Latest `mcp.json` overriding this server's `enabled`, `defaultActive`, `exposure` or `toolExposure`. */
	override?: string;
	overrideScope?: "global" | "project";
}

export interface LoadedMcpConfig {
	servers: McpServerEntry[];
	errors: string[];
	/** Writable global configuration; fallback files are read-only defaults. */
	globalConfig?: string;
	/** The project `mcp.json` when the project is trusted, where `/mcp` saves project overrides. */
	projectConfig?: string;
}

const OVERRIDE_KEYS = ["enabled", "defaultActive", "exposure", "toolExposure"];

/** Whether an entry overrides a server defined elsewhere instead of defining one. */
function isMcpOverride(value: Record<string, unknown>): boolean {
	return value.command === undefined && value.url === undefined && value.type === undefined;
}

interface McpConfigState {
	servers: Map<string, McpServerEntry>;
	errors: string[];
}

/** The `mcpServers` object of one file: nothing when the file is missing, an error when it cannot be used. */
function parseConfigFile(path: string): { servers: Record<string, unknown> } | { error: string } | undefined {
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(stripBom(readFileSync(path, "utf8"))));
	} catch (error) {
		return { error: `${path}: ${errorMessage(error)}` };
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)))
		return { error: `${path}: expected an object with an "mcpServers" object` };
	return { servers: parsed.mcpServers ?? {} };
}

/** What one `mcp.json` holds, for listing: each server name and whether the entry only overrides another server. */
export function listMcpFileEntries(path: string): { entries: { name: string; override: boolean }[]; error?: string } {
	const file = parseConfigFile(path);
	if (!file) return { entries: [] };
	if ("error" in file) return { entries: [], error: file.error };
	return {
		entries: Object.entries(file.servers).map(([name, value]) => ({
			name,
			override: isRecord(value) && isMcpOverride(value),
		})),
	};
}

function readConfigFile(path: string, scope: "global" | "project", state: McpConfigState): void {
	const { servers, errors } = state;
	const file = parseConfigFile(path);
	if (!file) return;
	if ("error" in file) {
		errors.push(file.error);
		return;
	}
	const names = new Map<string, string>();
	for (const [name, value] of Object.entries(file.servers)) {
		const namespace = mcpNamespace(name);
		const clash = names.get(namespace);
		if (clash && clash !== name) {
			errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
			continue;
		}
		if (isRecord(value) && isMcpOverride(value)) {
			const base = servers.get(namespace);
			const extra = Object.keys(value).filter((key) => !OVERRIDE_KEYS.includes(key));
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
		// The purpose describes the server under that name (the built-in's, say), so a replacement without its own keeps it.
		const inherited = config.description === undefined ? servers.get(namespace)?.config.description : undefined;
		servers.set(namespace, {
			name,
			config: inherited === undefined ? config : { ...config, description: inherited },
			source: path,
			scope,
		});
		names.set(namespace, name);
	}
}

/**
 * Load global and (when trusted) project MCP configuration. Disabled servers are included with
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
	};
	const globalConfig = globalMcpConfigPath(options.agentDir);
	for (const file of globalMcpConfigPaths(options.agentDir)) readConfigFile(file, "global", state);
	const projectConfig = options.projectTrusted ? projectMcpConfigPath(options.cwd) : undefined;
	if (projectConfig) {
		for (const file of projectMcpConfigPaths(options.cwd)) readConfigFile(file, "project", state);
	}
	return {
		servers: [...state.servers.values()],
		errors: state.errors,
		globalConfig,
		...(projectConfig ? { projectConfig } : {}),
	};
}

/**
 * Settings `/mcp` changes. `enabled: true`, `defaultActive: true` and `exposure: "direct"` are the defaults and remove
 * the key.
 */
export interface McpServerConfigPatch {
	enabled?: boolean;
	defaultActive?: boolean;
	exposure?: McpExposure;
}

/**
 * Apply `patch` to a server's settings, in a file record or in memory, so both end up the same:
 * defaults remove their key, except in overrides, which keep them since they replace the global
 * server's.
 */
export function applyMcpServerPatch(
	server: { enabled?: unknown; defaultActive?: unknown; exposure?: unknown },
	patch: McpServerConfigPatch,
	keepDefaults: boolean,
): void {
	if (patch.enabled !== undefined) {
		if (patch.enabled && !keepDefaults) delete server.enabled;
		else server.enabled = patch.enabled;
	}
	if (patch.defaultActive !== undefined) {
		if (patch.defaultActive && !keepDefaults) delete server.defaultActive;
		else server.defaultActive = patch.defaultActive;
	}
	if (patch.exposure !== undefined) {
		if (patch.exposure === DEFAULT_MCP_EXPOSURE && !keepDefaults) delete server.exposure;
		else server.exposure = patch.exposure;
	}
}

/**
 * Change one server's settings in the `mcp.json` that defines or overrides it. With `override`, a
 * missing entry is added as an override. Overrides keep default values, since they replace the global
 * server's. Other content is kept; the file is rewritten with its indentation.
 */
export function updateMcpServerConfig(
	path: string,
	name: string,
	patch: McpServerConfigPatch,
	options: { override?: boolean } = {},
): void {
	editMcpServers(path, (servers, parsed) => {
		let server = servers?.[name];
		if (server === undefined && options.override) {
			server = {};
			parsed.mcpServers = { ...servers, [name]: server };
		}
		if (!isRecord(server)) throw new Error(`${path} does not define MCP server "${name}"`);
		applyMcpServerPatch(server, patch, isMcpOverride(server));
		return true;
	});
}

/**
 * Add a server to an `mcp.json`, creating the file when missing. An existing entry with the same
 * name is replaced. Returns true when an entry was replaced.
 */
export function addMcpServerConfig(path: string, name: string, config: McpServerConfig): boolean {
	let replaced = false;
	editMcpServers(path, (servers, parsed) => {
		const target = servers ?? {};
		replaced = target[name] !== undefined;
		target[name] = config;
		parsed.mcpServers = target;
		return true;
	});
	return replaced;
}

/** Remove a server from an `mcp.json`. Returns false when the file does not define it. */
export function removeMcpServerConfig(path: string, name: string): boolean {
	if (!existsSync(path)) return false;
	let removed = false;
	editMcpServers(path, (servers) => {
		if (!servers || servers[name] === undefined) return false;
		delete servers[name];
		removed = true;
		return true;
	});
	return removed;
}

/**
 * Read an `mcp.json` (an empty config when missing), let `edit` change its `mcpServers`, and write
 * it back with its indentation when `edit` returns true. Other content is kept; comments are not, so
 * a commented file is first saved as `<file>.bak`.
 */
function editMcpServers(
	path: string,
	edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): void {
	const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
	const parsed: unknown = text === undefined ? {} : JSON.parse(stripJsonComments(stripBom(text)));
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		throw new Error(`${path}: expected an object with an "mcpServers" object`);
	}
	const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
	if (!edit(servers, parsed)) return;
	const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
	mkdirSync(dirname(path), { recursive: true });
	if (text && hasJsonComments(text)) atomicWriteFileSync(`${path}.bak`, text);
	atomicWriteFileSync(path, `${JSON.stringify(parsed, null, indent)}\n`);
}
