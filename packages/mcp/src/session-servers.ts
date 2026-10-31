/**
 * Live servers registered by extensions or the model's `mcp` tool. Subagents inherit them through an owner-only
 * transient file, without changing `mcp.json`. Configured servers are loaded by each session's normal config loader.
 */

import fs from "node:fs";
import type { EventBus } from "../../coding-agent/src/core/event-bus.ts";
import type { ExtensionAPI } from "../../coding-agent/src/core/extensions/types.ts";
import { type McpServerConfig, validateMcpServerConfig } from "./servers.ts";
import { envFlag, MCP_SESSION_SERVERS_FILE_ENV, SUBAGENT_ENV } from "../../common/src/env.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

const REQUEST_ADDED_SERVERS = "mcp:added-servers:request";
const FILE_VERSION = 1;
/** A handoff file larger than this is not a server list. */
const MAX_FILE_BYTES = 256 * 1024;

type AddedServers = Readonly<Record<string, McpServerConfig>>;

/** The owner of the session's added servers answers requests for them. Returns the unregistration. */
export function registerMcpAddedServers(events: EventBus, provider: () => AddedServers): () => void {
	return events.on(REQUEST_ADDED_SERVERS, (reply) => {
		if (typeof reply === "function") (reply as (servers: AddedServers) => void)(provider());
	});
}

/** Live session registrations to inherit, including plugin servers; empty when no MCP host answers. */
export function getMcpAddedServers(events: EventBus): AddedServers {
	let servers: AddedServers = {};
	events.emit(REQUEST_ADDED_SERVERS, (added: AddedServers) => {
		servers = added;
	});
	return servers;
}

/** The text of a handoff file for `servers`, or undefined when there is none. */
export function serializeMcpSessionServers(servers: AddedServers): string | undefined {
	return Object.keys(servers).length === 0 ? undefined : JSON.stringify({ version: FILE_VERSION, servers });
}

/** Servers in a handoff file; entries that fail validation are left out and named in `errors`. */
export function parseMcpSessionServers(text: string): { servers: Record<string, McpServerConfig>; errors: string[] } {
	const servers: Record<string, McpServerConfig> = {};
	const errors: string[] = [];
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || value.version !== FILE_VERSION || !isRecord(value.servers))
		throw new Error("not a session server list");
	for (const [name, config] of Object.entries(value.servers)) {
		const validated = validateMcpServerConfig(name, config);
		if (typeof validated === "string") errors.push(validated);
		else servers[name] = validated;
	}
	return { servers, errors };
}

/**
 * In a subagent, registers the servers its parent's `mcp` tool added. Without the file, or when it cannot be read,
 * the child runs with its configured servers only.
 */
export function registerInheritedMcpServers(api: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	const file = env[MCP_SESSION_SERVERS_FILE_ENV];
	if (!file || !envFlag(env, SUBAGENT_ENV)) return;
	try {
		if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error("file too large");
		const { servers, errors } = parseMcpSessionServers(fs.readFileSync(file, "utf8"));
		for (const message of errors) process.stderr.write(`Ignored inherited MCP server: ${message}\n`);
		for (const [name, config] of Object.entries(servers)) api.registerMcpServer(name, config);
	} catch (error) {
		process.stderr.write(
			`Inherited MCP servers unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}
