/**
 * On-demand exposure (`toolExposure: "onDemand"`). Such a tool is registered and callable but left out of the request's
 * tool list: its server's block lists it by name and trigger, and the session declares it the first time it needs it,
 * when the `mcp` tool reads its schema (intent `tools`) or the model calls it (the host's `ToolDefinition.onDemand`).
 * The declaration is then an addition after the cached prefix, so the tier applies only where the model's transport
 * adds tools mid-conversation (tool loading mode `changes` or `additions`) and the agent has the `mcp` tool to load
 * with. Everywhere else the tool is `deferred`, as is one the transcript already declares (a resumed or forked session
 * keeps what it sent) and, under `mcpExposure: "recent"` or `"usage"`, one in the session's in-use set (`direct`).
 */

import type { Api, Model } from "@octocodeai/octocode-ai";
import { supportsNativeToolLoading } from "@octocodeai/octocode-ai/utils/tool-loading";
import { MCP_MANAGE_TOOL_NAME } from "@octocodeai/octocode-common/mcp-names";
import type { McpServerEntry } from "./config.ts";
import { recentToolKey } from "./deferral.ts";
import { configuredMcpToolExposure } from "./servers.ts";
import type { McpExtensionState } from "./state.ts";

interface OnDemandSession {
	/** The session model's transport adds a declaration without rewriting the cached prefix. */
	capable: boolean;
	/** On-demand tools declared this session, as `<server>\0<tool>`: they stay declared in full. */
	loaded: Set<string>;
}

const sessions = new WeakMap<McpExtensionState, OnDemandSession>();

function sessionOf(state: McpExtensionState): OnDemandSession {
	let session = sessions.get(state);
	if (!session) sessions.set(state, (session = { capable: false, loaded: new Set() }));
	return session;
}

const keyOf = (server: string, tool: string): string => `${server}\0${tool}`;

/** Whether the configuration gives the tool on-demand exposure (it may still be `deferred` in this session). */
const configuredOnDemand = (entry: McpServerEntry, tool: string): boolean =>
	configuredMcpToolExposure(entry.config, tool) === "onDemand";

/** Read the session model's transport: a model switch to one without in-place additions declares every unloaded tool deferred. */
export function setOnDemandModel(state: McpExtensionState, model: unknown): void {
	const valid = typeof model === "object" && model !== null && typeof (model as { api?: unknown }).api === "string";
	sessionOf(state).capable = valid && supportsNativeToolLoading(model as Model<Api>);
}

/** A new session or another branch: the transcript says what is declared (`McpExtensionState.declaredBefore`). */
export function forgetOnDemandLoads(state: McpExtensionState): void {
	sessionOf(state).loaded.clear();
}

/** Record that an on-demand tool is declared from now on; true when it was not before. */
export function markOnDemandLoaded(state: McpExtensionState, server: string, tool: string): boolean {
	const { loaded } = sessionOf(state);
	if (loaded.has(keyOf(server, tool))) return false;
	loaded.add(keyOf(server, tool));
	return true;
}

/** The on-demand tools of the server this session has declared, by the server's tool names. */
export function loadedOnDemand(state: McpExtensionState, server: string): ReadonlySet<string> {
	const prefix = `${server}\0`;
	return new Set(
		[...sessionOf(state).loaded].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
	);
}

/**
 * Whether the tool is undeclared now: configured on demand, on a capable transport, with the `mcp` tool, neither in use
 * (`recentTools`) nor declared by the transcript, and not loaded this session. A tool the session activated some other
 * way (an explicit `--tools` entry, a call) counts as loaded.
 */
export function isOnDemand(state: McpExtensionState, entry: McpServerEntry, tool: string, name: string): boolean {
	if (!configuredOnDemand(entry, tool)) return false;
	const session = sessionOf(state);
	if (!session.capable || session.loaded.has(keyOf(entry.name, tool))) return false;
	const active = state.api.getActiveTools();
	if (!active.includes(MCP_MANAGE_TOOL_NAME) || state.declaredBefore.has(name)) return false;
	if (state.recentTools()?.has(recentToolKey(entry.name, tool))) return false;
	if (active.includes(name)) {
		session.loaded.add(keyOf(entry.name, tool));
		return false;
	}
	return true;
}
