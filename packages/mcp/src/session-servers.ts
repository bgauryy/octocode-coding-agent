/**
 * Live servers registered by extensions or the model's `mcp` tool, and the servers the parent stopped for this session
 * only (the `mcp` tool's `stop`; `/mcp disable` is saved to `mcp.json`, which children already read). Subagents
 * inherit both through an owner-only transient file, without changing `mcp.json`. Configured servers are loaded by
 * each session's normal config loader; the child then leaves out the ones the parent stopped, unless its tool
 * selection names the server explicitly (`mcp__<server>__*` in `tools`; the server's default-active flag does not
 * count), because a profile that asks for a server's tools has chosen it over the parent's session state.
 */

import fs from "node:fs";
import type { EventBus } from "@octocodeai/octocode-agent-core";
import type { McpExtensionApi } from "./host/types.ts";
import { type McpServerConfig, validateMcpServerConfig } from "./servers.ts";
import { envFlag, MCP_SESSION_SERVERS_FILE_ENV, SUBAGENT_ENV } from "../../common/src/env.ts";
import { mcpNamespace } from "../../common/src/mcp-names.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

const REQUEST_ADDED_SERVERS = "mcp:added-servers:request";
/** Version 1 lists servers only; version 2 adds `stopped`. A file without stopped servers stays version 1. */
const FILE_VERSION = 1;
const FILE_VERSION_STOPPED = 2;
/** A handoff file larger than this is not a server list. */
const MAX_FILE_BYTES = 256 * 1024;

type AddedServers = Readonly<Record<string, McpServerConfig>>;

/** What a child inherits: servers to register, and names of servers the parent stopped for this session. */
export interface McpSessionHandoff {
	servers: AddedServers;
	stopped: readonly string[];
}

/** The owner of the session's added servers answers requests for them. Returns the unregistration. */
export function registerMcpAddedServers(events: EventBus, provider: () => McpSessionHandoff): () => void {
	return events.on(REQUEST_ADDED_SERVERS, (reply) => {
		if (typeof reply === "function") (reply as (handoff: McpSessionHandoff) => void)(provider());
	});
}

/** Live session registrations and stops to inherit, including plugin servers; empty when no MCP host answers. */
export function getMcpSessionHandoff(events: EventBus): McpSessionHandoff {
	let handoff: McpSessionHandoff = { servers: {}, stopped: [] };
	events.emit(REQUEST_ADDED_SERVERS, (current: McpSessionHandoff) => {
		handoff = current;
	});
	return handoff;
}

/** The text of a handoff file, or undefined when there is nothing to hand over. */
export function serializeMcpSessionServers(servers: AddedServers, stopped: readonly string[] = []): string | undefined {
	if (Object.keys(servers).length === 0 && stopped.length === 0) return undefined;
	return stopped.length === 0
		? JSON.stringify({ version: FILE_VERSION, servers })
		: JSON.stringify({ version: FILE_VERSION_STOPPED, servers, stopped });
}

/** Servers and stopped names in a handoff file; entries that fail validation are left out and named in `errors`. */
export function parseMcpSessionServers(text: string): {
	servers: Record<string, McpServerConfig>;
	stopped: string[];
	errors: string[];
} {
	const servers: Record<string, McpServerConfig> = {};
	const errors: string[] = [];
	const value: unknown = JSON.parse(text);
	if (
		!isRecord(value) ||
		(value.version !== FILE_VERSION && value.version !== FILE_VERSION_STOPPED) ||
		!isRecord(value.servers)
	)
		throw new Error("not a session server list");
	const stopped =
		value.version === FILE_VERSION_STOPPED && Array.isArray(value.stopped)
			? value.stopped.filter((name): name is string => typeof name === "string")
			: [];
	for (const [name, config] of Object.entries(value.servers)) {
		const validated = validateMcpServerConfig(name, config);
		if (typeof validated === "string") errors.push(validated);
		else servers[name] = validated;
	}
	return { servers, stopped, errors };
}

/**
 * In a subagent, registers the servers its parent's `mcp` tool added and returns the names the parent stopped for
 * the session (apply them with `isParentStopped`). Without the file, or when it cannot be read, the child runs with
 * its configured servers only.
 */
export function registerInheritedMcpServers(api: McpExtensionApi, env: NodeJS.ProcessEnv = process.env): string[] {
	const file = env[MCP_SESSION_SERVERS_FILE_ENV];
	if (!file || !envFlag(env, SUBAGENT_ENV)) return [];
	try {
		if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error("file too large");
		const { servers, stopped, errors } = parseMcpSessionServers(fs.readFileSync(file, "utf8"));
		for (const message of errors) process.stderr.write(`Ignored inherited MCP server: ${message}\n`);
		for (const [name, config] of Object.entries(servers)) api.registerMcpServer(name, config);
		return stopped;
	} catch (error) {
		process.stderr.write(
			`Inherited MCP servers unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return [];
	}
}

/**
 * Whether a child leaves out the configured server `name` because its parent stopped it for the session: unless the
 * child's own tool selection names the server (`selectsTools` with the default-active flag off).
 */
export function isParentStopped(
	stopped: ReadonlySet<string>,
	name: string,
	api: Pick<McpExtensionApi, "selectsTools">,
): boolean {
	if (!stopped.has(name)) return false;
	return !(typeof api.selectsTools === "function" && api.selectsTools(`${mcpNamespace(name)}__`, false));
}
