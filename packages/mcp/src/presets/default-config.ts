/**
 * The default MCP servers and which agent gets which: data only, in `../default_mcp_config.json`. Behavior a server needs
 * beyond its data (the browser's launch and proxy, the desktop's Cua Driver discovery) lives in TypeScript keyed by the
 * server's name (`./index.ts`).
 *
 * `servers` maps a name to an `mcp.json` entry plus the fields only a default has: `enabledEnv`, the environment flag
 * that turns it off or on; `enabledByDefault`, false for a server the user turns on with that flag or a configuration
 * entry; `envDefaults`, launch env values added only when the user's own environment leaves that variable unset; and
 * `instructionsOnDemand` (`McpServerPreset.instructionsOnDemand`). Servers register in the file's order as
 * `scope: "default"` entries, which a user or project entry of the same name replaces; a saved switch (`/harness`,
 * `/settings`) is a control-only override and wins over both.
 *
 * `agents` maps the main session and each bundled profile to its servers, one of two ways:
 * - `servers`: an agent on the default tool selection runs these servers with their default tools. For `main`, a
 *   default server it does not list gets `defaultActive: false`; for a child, the listed servers join the servers it
 *   runs.
 * - `tools`: entries the profile's tool list gains: a server name (every tool of that server) or a full tool name or
 *   pattern (`mcp__browser__open`).
 * The file is checked when this module loads: bad data throws.
 */

import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { envFlag } from "@octocodeai/octocode-common/env";
import { mcpNamespace } from "@octocodeai/octocode-common/mcp-names";
import type { McpServerPreset } from "../preset.ts";
import { validateMcpServerConfig } from "../servers.ts";
import data from "../default_mcp_config.json" with { type: "json" };

/** One agent's assignment, with `tools` entries as full tool names or patterns. */
export type AgentMcp =
	| { servers: readonly string[]; tools?: undefined }
	| { tools: readonly string[]; servers?: undefined };

export interface DefaultMcpConfig {
	servers: Readonly<Record<string, Record<string, unknown>>>;
	agents: Readonly<Record<string, AgentMcp>>;
}

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isStringRecord = (value: unknown): value is Record<string, string> =>
	isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");

/** The file's content, checked: every agent names known servers, and `main` lists its servers. Throws on bad data. */
export function parseDefaultMcpConfig(value: unknown): DefaultMcpConfig {
	if (!isRecord(value) || !isRecord(value.servers) || !isRecord(value.agents))
		throw new Error("default MCP config needs `servers` and `agents` objects");
	const servers: Record<string, Record<string, unknown>> = {};
	for (const [name, entry] of Object.entries(value.servers)) {
		if (!isRecord(entry)) throw new Error(`default MCP server "${name}" must be an object`);
		servers[name] = entry;
	}
	const agents: Record<string, AgentMcp> = {};
	for (const [agent, entry] of Object.entries(value.agents)) agents[agent] = agentMcp(agent, entry, servers);
	if (!agents.main?.servers) throw new Error("default MCP config: agent `main` needs a `servers` list");
	return { servers, agents };
}

function agentMcp(agent: string, entry: unknown, servers: Record<string, unknown>): AgentMcp {
	const fail = (problem: string) => new Error(`default MCP agent "${agent}": ${problem}`);
	if (!isRecord(entry) || (entry.servers === undefined) === (entry.tools === undefined))
		throw fail("give either `servers` or `tools`");
	const list = entry.servers ?? entry.tools;
	if (!isStringList(list)) throw fail("`servers` and `tools` must be lists of strings");
	const known = Object.keys(servers);
	if (entry.servers !== undefined) {
		const unknown = list.find((name) => !known.includes(name));
		if (unknown !== undefined) throw fail(`unknown server "${unknown}" (default servers: ${known.join(", ")})`);
		return { servers: list };
	}
	return {
		tools: list.map((tool) => {
			if (known.includes(tool)) return `${mcpNamespace(tool)}__*`;
			if (known.some((name) => tool.startsWith(`${mcpNamespace(name)}__`))) return tool;
			throw fail(`"${tool}" is neither a default server nor one of its tools (mcp__<server>__<tool>)`);
		}),
	};
}

const CONFIG = parseDefaultMcpConfig(data);

/**
 * One server entry as a preset: its configuration with `enabled` from its environment flag, else from its
 * `enabledByDefault` (on when unset). `defaultActive: false` marks a server the main agent does not get by default.
 */
export function serverPreset(
	name: string,
	entry: unknown,
	env: NodeJS.ProcessEnv = process.env,
	defaultActive = true,
): McpServerPreset {
	if (!isRecord(entry)) throw new Error(`default MCP server "${name}" must be an object`);
	const { enabledEnv, enabledByDefault, envDefaults, instructionsOnDemand, ...rest } = entry;
	const fail = (problem: string) => new Error(`default MCP server "${name}": ${problem}`);
	if (enabledEnv !== undefined && typeof enabledEnv !== "string") throw fail("enabledEnv must be a string");
	if (enabledByDefault !== undefined && typeof enabledByDefault !== "boolean")
		throw fail("enabledByDefault must be true or false");
	if (envDefaults !== undefined && !isStringRecord(envDefaults)) throw fail("envDefaults must map names to strings");
	if (instructionsOnDemand !== undefined && typeof instructionsOnDemand !== "boolean")
		throw fail("instructionsOnDemand must be a boolean");
	const launchEnv = { ...unsetIn(env, envDefaults), ...(isRecord(rest.env) ? rest.env : {}) };
	const byDefault = enabledByDefault !== false;
	const gated = enabledEnv !== undefined || enabledByDefault !== undefined;
	const config = validateMcpServerConfig(name, {
		...rest,
		...(Object.keys(launchEnv).length > 0 ? { env: launchEnv } : {}),
		...(gated ? { enabled: enabledEnv ? envFlag(env, enabledEnv, byDefault) : byDefault } : {}),
		...(defaultActive ? {} : { defaultActive: false }),
	});
	if (typeof config === "string") throw fail(config);
	return { name, config, ...(instructionsOnDemand ? { instructionsOnDemand } : {}) };
}

/** The defaults whose variable `env` leaves unset: a value the user set reaches the server unchanged. */
function unsetIn(env: NodeJS.ProcessEnv, defaults: Record<string, string> | undefined): Record<string, string> {
	return Object.fromEntries(Object.entries(defaults ?? {}).filter(([key]) => env[key] === undefined));
}

/** The default servers' names, in the file's order. */
export const defaultServerNames = (config: DefaultMcpConfig = CONFIG): string[] => Object.keys(config.servers);

/** A default server's data as a preset, without the behavior `./index.ts` adds. Throws for a name the file lacks. */
export function defaultServerPreset(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
	config: DefaultMcpConfig = CONFIG,
): McpServerPreset {
	const entry = config.servers[name];
	if (!entry) throw new Error(`no default MCP server "${name}"`);
	return serverPreset(name, entry, env, config.agents.main.servers?.includes(name) === true);
}

/** An agent's assignment (`main`, `general` or a bundled profile's name); undefined for an agent the file does not list. */
export const defaultAgentMcp = (agent: string, config: DefaultMcpConfig = CONFIG): AgentMcp | undefined =>
	Object.hasOwn(config.agents, agent) ? config.agents[agent] : undefined;
