/**
 * The MCP servers an ACP client attaches to a session. The ACP broker writes a private manifest (data, never code) and
 * names it in `ACP_MCP_MANIFEST_ENV` of the worker it spawns; the worker's MCP host registers the servers from it and
 * reports readiness in `ready.json` beside the manifest, so the broker can refuse a session whose registration failed.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { ACP_MCP_MANIFEST_ENV, ACP_WORKER_ENV, envFlag } from "@octocodeai/octocode-common/env";
import { mcpNamespace } from "@octocodeai/octocode-common/mcp-names";
import type { McpFeatureApi } from "./host/types.ts";
import { validateMcpServerConfig } from "./servers.ts";
import { type McpServerConfig } from "@octocodeai/octocode-contracts/mcp-server";

export const ACP_MCP_MANIFEST_FILE = "manifest.json";
export const ACP_MCP_LAUNCHER_FILE = "launcher.mjs";
export const ACP_MCP_READY_FILE = "ready.json";
export const ACP_MCP_MANIFEST_VERSION = 1;
/** A manifest larger than this is not a server list. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** One client server, already validated by the broker. */
export interface AcpMcpServerDefinition {
	name: string;
	namespace: string;
	command?: string;
	args?: string[];
	env?: Array<{ name: string; value: string }>;
	type?: "http";
	url?: string;
	headers?: Record<string, string>;
}

export interface AcpMcpManifest {
	version: typeof ACP_MCP_MANIFEST_VERSION;
	cwd: string;
	/** The Node runtime that runs the launcher. */
	runtime: string;
	servers: AcpMcpServerDefinition[];
}

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string");

function parseDefinition(value: unknown, index: number): AcpMcpServerDefinition {
	const where = `servers[${index}]`;
	if (!isRecord(value)) throw new Error(`${where} must be an object`);
	if (typeof value.name !== "string" || typeof value.namespace !== "string")
		throw new Error(`${where} needs a string name and namespace`);
	const http = typeof value.url === "string";
	if (http) {
		if (value.type !== "http") throw new Error(`${where} has a url but is not type "http"`);
		if (
			value.headers !== undefined &&
			!(isRecord(value.headers) && Object.values(value.headers).every((v) => typeof v === "string"))
		)
			throw new Error(`${where}.headers must map names to strings`);
	} else {
		if (typeof value.command !== "string") throw new Error(`${where} needs a command or a url`);
		if (!isStringArray(value.args)) throw new Error(`${where}.args must be a string array`);
		if (
			!Array.isArray(value.env) ||
			!value.env.every((entry) => isRecord(entry) && typeof entry.name === "string" && typeof entry.value === "string")
		)
			throw new Error(`${where}.env must be a list of name/value entries`);
	}
	return value as unknown as AcpMcpServerDefinition;
}

/** Parse a manifest, refusing any other shape with a message that names the field. */
function parseAcpMcpManifest(text: string): AcpMcpManifest {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || value.version !== ACP_MCP_MANIFEST_VERSION) throw new Error("not an ACP MCP manifest");
	if (typeof value.cwd !== "string" || typeof value.runtime !== "string")
		throw new Error("manifest needs a string cwd and runtime");
	if (!Array.isArray(value.servers)) throw new Error("manifest servers must be a list");
	return {
		version: ACP_MCP_MANIFEST_VERSION,
		cwd: value.cwd,
		runtime: value.runtime,
		servers: value.servers.map(parseDefinition),
	};
}

/** The registration for one client server: HTTP directly, a stdio server through the broker's launcher. */
function serverConfig(
	server: AcpMcpServerDefinition,
	index: number,
	manifest: AcpMcpManifest,
	directory: string,
): McpServerConfig | string {
	const common = { description: `ACP client MCP server: ${server.name}`, exposure: "direct" as const };
	return validateMcpServerConfig(
		server.namespace,
		server.url
			? { ...common, type: "http", url: server.url, headers: server.headers, literalHeaders: true }
			: {
					...common,
					command: manifest.runtime,
					args: [join(directory, ACP_MCP_LAUNCHER_FILE), join(directory, ACP_MCP_MANIFEST_FILE), String(index)],
					cwd: manifest.cwd,
				},
	);
}

/**
 * In an ACP worker, registers the client's MCP servers named by `ACP_MCP_MANIFEST_ENV`. Does nothing outside an ACP
 * worker or without the variable. A bad manifest or a namespace that is already registered registers nothing and is
 * reported through `ready.json`, which the broker reads before it exposes the session.
 */
export function registerAcpClientMcpServers(api: McpFeatureApi, env: NodeJS.ProcessEnv = process.env): void {
	const manifestPath = env[ACP_MCP_MANIFEST_ENV];
	if (!manifestPath || !envFlag(env, ACP_WORKER_ENV)) return;
	const directory = dirname(manifestPath);
	const report = (value: { ready: true } | { error: string }) =>
		writeFileSync(join(directory, ACP_MCP_READY_FILE), JSON.stringify(value), { mode: 0o600 });
	try {
		if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) throw new Error("manifest too large");
		const manifest = parseAcpMcpManifest(readFileSync(manifestPath, "utf8"));
		const occupied = new Set(api.mcpServers.list().map((server) => mcpNamespace(server.name)));
		const configs: Array<[string, McpServerConfig]> = [];
		for (const [index, server] of manifest.servers.entries()) {
			if (occupied.has(mcpNamespace(server.namespace)))
				throw new Error(`ACP MCP namespace already registered: ${server.namespace}`);
			occupied.add(mcpNamespace(server.namespace));
			const config = serverConfig(server, index, manifest, directory);
			if (typeof config === "string") throw new Error(config);
			configs.push([server.namespace, config]);
		}
		for (const [name, config] of configs) api.mcpServers.register(name, config);
		api.bus.on("session_start", () => report({ ready: true }));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`ACP client MCP servers unavailable: ${message}\n`);
		try {
			report({ error: message });
		} catch {
			// The broker's verify() then reports that the worker never initialized.
		}
	}
}
