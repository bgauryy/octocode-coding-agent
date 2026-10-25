import type { EventBus } from "../../coding-agent/src/core/event-bus.ts";
import type { McpExposure } from "./servers.ts";

export interface McpServerStatus {
	name: string;
	enabled: boolean;
	state: string;
	exposure: McpExposure;
	toolCount: number;
	source: string;
	scope?: "global" | "project" | "extension" | "default";
}

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
