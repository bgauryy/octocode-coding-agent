/**
 * What this session declares of each MCP tool and what decided it, for a settings view. The registry publishes a reader
 * (`registerMcpHost`); a process without a session (the web daemon) has none. Reading never connects a server.
 */

import type { McpExposure, McpServerEntry } from "./config.ts";
import { defersByRecentUse } from "./deferral.ts";
import { isEnabled, type McpServer } from "./server.ts";
import { configuredMcpToolExposure } from "./servers.ts";

/**
 * What decided a tool's state: its own `toolExposure` entry (`pin`), a `toolExposure` pattern, the server's `exposure`,
 * recent use under `mcpExposure: "recent"`, another deferral of the session (the `mcpExposure` setting or a deferred
 * role), or nothing (`default`).
 */
type McpToolDecision = "pin" | "pattern" | "server" | "recent" | "setting" | "default";

interface McpToolState {
	/** The tool's name as the server offers it. */
	name: string;
	state: McpExposure;
	decidedBy: McpToolDecision;
}

export interface McpServerToolStates {
	server: string;
	/** False while the server is not connected: its tools are then unknown. */
	connected: boolean;
	/** False for a server an extension registered: its configuration is not saved. */
	saved: boolean;
	tools: McpToolState[];
}

/** What the reader needs of the extension state, so this module does not depend on it. */
interface McpToolStateSource {
	servers: readonly McpServer[];
	toolExposure(entry: McpServerEntry, tool: string): McpExposure;
	exposureSetting(): unknown;
}

function decisionOf(entry: McpServerEntry, tool: string, state: McpExposure, setting: unknown): McpToolDecision {
	const pins = entry.config.toolExposure;
	if (pins?.[tool] !== undefined) return "pin";
	if (configuredMcpToolExposure({ ...entry.config, exposure: undefined }, tool) !== undefined) return "pattern";
	const recent = defersByRecentUse(setting);
	// The session declares something else than the configuration says: a deferral decided it.
	if (state !== (entry.config.exposure ?? "direct")) return recent ? "recent" : "setting";
	if (entry.config.exposure !== undefined) return "server";
	return recent ? "recent" : "default";
}

/** Every enabled server of the session with the state of each tool it offers. */
export function mcpToolStates(source: McpToolStateSource): McpServerToolStates[] {
	const setting = source.exposureSetting();
	return source.servers.filter(isEnabled).map(({ entry, connection }) => {
		const connected = connection?.state === "connected";
		return {
			server: entry.name,
			connected,
			saved: entry.scope !== "extension",
			tools: (connected ? connection.tools : []).map((tool) => {
				const state = source.toolExposure(entry, tool.name);
				return { name: tool.name, state, decidedBy: decisionOf(entry, tool.name, state, setting) };
			}),
		};
	});
}

let reader: (() => McpServerToolStates[]) | undefined;
let serverNamesReader: (() => string[] | undefined) | undefined;

/** Sets the session's reader; the MCP registry calls it once. */
export function publishMcpToolStates(
	read: () => McpServerToolStates[],
	readServerNames?: () => string[] | undefined,
): void {
	reader = read;
	serverNamesReader = readServerNames;
}

/** All registered names, including disabled, withheld and pending entries; undefined means unavailable. */
export function currentMcpServerNames(): string[] | undefined {
	return serverNamesReader?.();
}

/** The session's tool states, or undefined in a process that runs no session. */
export function currentMcpToolStates(): McpServerToolStates[] | undefined {
	return reader?.();
}
