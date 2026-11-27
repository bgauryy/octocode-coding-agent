import type { EventBus } from "@octocodeai/octocode-agent-core";
import type { McpServerGroup } from "./group.ts";
import type { McpExposure } from "@octocodeai/octocode-contracts/mcp-server";

export interface McpServerStatus {
	name: string;
	enabled: boolean;
	state: string;
	exposure: McpExposure;
	/** `defaultActive` of the server's configuration; absent counts as true. */
	defaultActive?: boolean;
	toolCount: number;
	source: string;
	scope?: "global" | "project" | "feature" | "default";
	/** The listing group (`mcpServerGroup`): core, workspace or global, as skills are grouped. */
	group?: McpServerGroup;
}

/**
 * Whether the server may run in this session: switched on, and not held back by the security review (state
 * `not checked`, whatever its switch). Only then may its tools, its research route or its reader be offered.
 */
export const mcpServerMayRun = (server: Pick<McpServerStatus, "enabled" | "state">): boolean =>
	server.enabled && server.state !== "not checked";

export const MCP_STATUS_EVENT = "mcp:status";
const REQUEST_STATUS = "mcp:status:request";

const snapshots = new WeakMap<EventBus, readonly McpServerStatus[]>();

/** Session status without transport arguments, credentials, or server error payloads. */
export function getMcpSessionStatus(events: EventBus): McpServerStatus[] {
	let snapshot: readonly McpServerStatus[] = [];
	events.emit(REQUEST_STATUS, (servers: readonly McpServerStatus[]) => {
		snapshot = servers;
	});
	return snapshot.map((server) => ({ ...server })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The session host publishes one complete registry snapshot. */
export function setMcpSessionStatus(events: EventBus, servers: readonly McpServerStatus[]): void {
	if (!snapshots.has(events)) {
		events.on(REQUEST_STATUS, (reply) => {
			if (typeof reply === "function") reply(snapshots.get(events) ?? []);
		});
	}
	snapshots.set(
		events,
		servers.map((server) => ({ ...server })),
	);
	events.emit(MCP_STATUS_EVENT, getMcpSessionStatus(events));
}
