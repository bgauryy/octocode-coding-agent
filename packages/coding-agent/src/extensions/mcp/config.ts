/**
 * MCP server configuration.
 *
 * Servers are read from global fallbacks through the writable agent directory, then trusted project
 * paths. Each uses the `mcpServers` shape shared by other MCP clients. Later entries replace earlier
 * transports with the same namespace; conflicting spellings within one file are refused.
 *
 * An entry without `command`, `url`, or `type` overrides only `enabled`, `exposure`, and
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
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { globalMcpConfigPaths, projectMcpConfigPaths } from "../../core/mcp-config-paths.ts";
import {
	DEFAULT_MCP_EXPOSURE,
	type McpExposure,
	type McpServerConfig,
	mcpNamespace,
	validateMcpServerConfig,
} from "../../core/mcp-servers.ts";
import { hasJsonComments, stripJsonComments } from "../../utils/json.ts";
import { stripBom } from "../../utils/text.ts";
import { atomicWriteFileSync } from "../../utils/atomic-file.ts";

export type {
	McpExposure,
	McpHttpServerConfig,
	McpOAuthConfig,
	McpServerConfig,
	McpStdioServerConfig,
} from "../../core/mcp-servers.ts";
export { getMcpToolExposure } from "../../core/mcp-servers.ts";

export interface McpServerEntry {
	name: string;
	config: McpServerConfig;
	/** Config file that defined the entry, or the path of the extension that registered it. */
	source: string;
	/**
	 * The global or the project `mcp.json`, or `extension` for servers registered with
	 * `pi.registerMcpServer()`. Changes to extension servers are not saved.
	 */
	scope?: "global" | "project" | "extension";
	/** Latest `mcp.json` overriding this server's `enabled`, `exposure`, or `toolExposure`. */
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

const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

/** Whether an entry overrides a server defined elsewhere instead of defining one. */
function isOverride(value: Record<string, unknown>): boolean {
	return value.command === undefined && value.url === undefined && value.type === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface McpConfigState {
	servers: Map<string, McpServerEntry>;
	errors: string[];
}

function readConfigFile(path: string, scope: "global" | "project", state: McpConfigState): void {
	const { servers, errors } = state;
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(stripBom(readFileSync(path, "utf8"))));
	} catch (error) {
		errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		errors.push(`${path}: expected an object with an "mcpServers" object`);
		return;
	}
	const names = new Map<string, string>();
	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		const namespace = mcpNamespace(name);
		const clash = names.get(namespace);
		if (clash && clash !== name) {
			errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
			continue;
		}
		if (isRecord(value) && isOverride(value)) {
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
		servers.set(namespace, { name, config, source: path, scope });
		names.set(namespace, name);
	}
}

/**
 * Load global and (when trusted) project MCP configuration. Disabled servers are included with
 * `enabled: false`, so they can be enabled again.
 */
export function loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig {
	const state: McpConfigState = { servers: new Map(), errors: [] };
	const globalConfig = join(options.agentDir, "mcp.json");
	for (const file of globalMcpConfigPaths(options.agentDir)) readConfigFile(file, "global", state);
	const projectConfig = options.projectTrusted ? join(options.cwd, CONFIG_DIR_NAME, "mcp.json") : undefined;
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

/** Settings `/mcp` changes. `enabled: true` and `exposure: "auto"` are the defaults and remove the key. */
export interface McpServerConfigPatch {
	enabled?: boolean;
	exposure?: McpExposure;
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
		const keepDefaults = isOverride(server);
		if (patch.enabled !== undefined) {
			if (patch.enabled && !keepDefaults) delete server.enabled;
			else server.enabled = patch.enabled;
		}
		if (patch.exposure !== undefined) {
			if (patch.exposure === DEFAULT_MCP_EXPOSURE && !keepDefaults) delete server.exposure;
			else server.exposure = patch.exposure;
		}
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
