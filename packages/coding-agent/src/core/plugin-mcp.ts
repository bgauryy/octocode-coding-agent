import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { stripBom } from "../../../common/src/text.ts";
import { repoKey } from "../utils/git-repository.ts";
import { validateMcpServerConfig } from "../../../mcp/src/servers.ts";
import { type McpServerConfig } from "@octocodeai/octocode-contracts/mcp-server";
import { mcpNamespace } from "../../../common/src/mcp-names.ts";
import { pluginContext } from "./plugin-context.ts";
import { resolveConfiguredPlugin, resolvePluginPath, type PluginManifest } from "./plugin-manifest.ts";
import { configuredPlugins } from "./plugin-settings.ts";
import type { Settings } from "./settings-manager.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

type PluginEntry = NonNullable<Settings["plugins"]>[number];
type Server = { name: string; config: McpServerConfig };

/** Read declarations without connecting servers or running package code; non-empty `errors` means none load. */
export function inspectPluginMcp(entry: PluginEntry): {
	manifest?: PluginManifest;
	servers: Server[];
	errors: string[];
} {
	const result: ReturnType<typeof inspectPluginMcp> = {
		servers: [],
		errors: [],
	};
	try {
		const { manifest, errors, failure } = resolveConfiguredPlugin(entry);
		result.errors.push(...errors);
		if (!manifest) throw new Error(failure);
		result.manifest = manifest;
		const servers = new Map<string, McpServerConfig>();
		const add = (value: unknown, source: string) => {
			if (!isRecord(value)) throw new Error(`${source}: expected an MCP server map`);
			for (const [name, raw] of Object.entries(value)) {
				if (!isRecord(raw)) throw new Error(`${source}: server ${name} must be an object`);
				const fields = ["type", "command", "args", "env", "cwd", "url", "headers"];
				const extra = Object.keys(raw).filter((key) => !fields.includes(key));
				if (extra.length) throw new Error(`${source}: unsupported server ${name} fields: ${extra.join(", ")}`);
				if (manifest.protocol === "claude" && raw.url !== undefined && raw.type === undefined)
					throw new Error(`${source}: HTTP server ${name} requires type`);
				// Validate without expanding placeholders; URL placeholders need the actual project at activation.
				const candidate =
					typeof raw.url === "string" ? { ...raw, url: raw.url.replace(/\$\{[^}]+\}/g, "placeholder") } : raw;
				const checked = validateMcpServerConfig(name, candidate);
				if (typeof checked === "string") throw new Error(`${source}: ${checked}`);
				servers.set(name, raw as unknown as McpServerConfig);
			}
		};
		const read = (relative: string, optional = false) => {
			try {
				lstatSync(path.resolve(manifest.root, relative));
			} catch (error) {
				if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return;
				throw error;
			}
			const source = resolvePluginPath(manifest.root, relative);
			if (path.extname(source) !== ".json") throw new Error(`${relative}: MCP bundles are not supported`);
			const text = readFileSync(source, "utf8");
			const value: unknown = JSON.parse(stripBom(text));
			if (!isRecord(value) || !isRecord(value.mcpServers)) throw new Error(`${source}: expected an mcpServers object`);
			add(value.mcpServers, source);
		};
		const declared = manifest.settings.mcpServers;
		if (manifest.protocol === "claude" || declared === undefined) read("./.mcp.json", true);
		if (declared !== undefined) {
			if (manifest.protocol === "codex" && Array.isArray(declared))
				throw new Error("Codex mcpServers must be a path or object");
			for (const item of Array.isArray(declared) ? declared : [declared]) {
				if (typeof item === "string") read(item);
				else add(item, `${manifest.root}#mcpServers`);
			}
		}
		result.servers = [...servers].map(([name, config]) => ({ name, config }));
	} catch (error) {
		result.errors.push(String(error));
	}
	return result;
}

function expand(value: unknown, variables: Record<string, string>): unknown {
	if (typeof value === "string")
		return value.replace(/\$\{([^}]+)\}/g, (placeholder, key: string) => variables[key] ?? placeholder);
	if (Array.isArray(value)) return value.map((item) => expand(item, variables));
	if (isRecord(value))
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, variables)]));
	return value;
}

/** Activate the declarations of enabled plugins (enabling approves them) through the existing MCP registry; the transport owner manages connections. */
export function loadConfiguredPluginMcp(
	entries: Settings["plugins"],
	projectRoot: string,
): { servers: Server[]; errors: string[] } {
	const result: ReturnType<typeof loadConfiguredPluginMcp> = {
		servers: [],
		errors: [],
	};
	const seen = new Set<string>();
	for (const entry of configuredPlugins(entries, (message) => result.errors.push(message))) {
		if (entry.enabled === false) continue;
		const inspected = inspectPluginMcp(entry);
		result.errors.push(...inspected.errors);
		if (!inspected.manifest || inspected.errors.length || !inspected.servers.length) continue;
		const context = pluginContext(inspected.manifest);
		const variables = {
			CLAUDE_PLUGIN_ROOT: context.root,
			CLAUDE_PLUGIN_DATA: context.data,
			CLAUDE_PROJECT_DIR: repoKey(projectRoot).root,
			...(entry.protocol === "codex" ? { PLUGIN_ROOT: context.root, PLUGIN_DATA: context.data } : {}),
		};
		for (const server of inspected.servers) {
			const name = `plugin:${inspected.manifest.name}:${server.name}`;
			const config = validateMcpServerConfig(name, expand(server.config, variables));
			if (typeof config === "string") {
				result.errors.push(`${entry.path}: ${config}`);
				continue;
			}
			if ("command" in config) {
				try {
					mkdirSync(context.data, { recursive: true, mode: 0o700 });
				} catch (error) {
					result.errors.push(`${entry.path}: cannot create plugin data directory: ${String(error)}`);
					continue;
				}
				config.env = { ...config.env, ...variables };
			}
			const namespace = mcpNamespace(name);
			if (seen.has(namespace)) {
				result.errors.push(`${entry.path}: duplicate plugin MCP namespace ${namespace}`);
				continue;
			}
			seen.add(namespace);
			result.servers.push({ name, config });
		}
	}
	return result;
}
