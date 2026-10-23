import type { EventBus } from "../../core/event-bus.ts";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { McpExposure } from "../../core/mcp-servers.ts";

export interface McpServerStatus {
	name: string;
	enabled: boolean;
	state: string;
	exposure: McpExposure;
	toolCount: number;
	source: string;
	scope?: "global" | "project" | "extension";
}

export const MCP_STATUS_EVENT = "mcp:status";
const REQUEST_STATUS = "mcp:status:request";
const REQUEST_RECONNECT = "mcp:reconnect:request";
type Reconnect = (ctx: ExtensionContext) => Promise<string | undefined>;

export function registerMcpReconnect(events: EventBus, name: string, reconnect: Reconnect): () => void {
	return events.on(REQUEST_RECONNECT, (request) => {
		const value = request as { name?: string; reply?: (reconnect: Reconnect) => void } | undefined;
		if (value?.name === name && typeof value.reply === "function") value.reply(reconnect);
	});
}

export function getMcpReconnect(events: EventBus, name: string): Reconnect | undefined {
	let reconnect: Reconnect | undefined;
	events.emit(REQUEST_RECONNECT, {
		name,
		reply: (handler: Reconnect) => {
			reconnect = handler;
		},
	});
	return reconnect;
}
const publishersByOwner = new WeakMap<EventBus, Map<string, readonly McpServerStatus[]>>();

/** Session status without transport arguments, credentials, or server error payloads. */
export function getMcpSessionStatus(events: EventBus): McpServerStatus[] {
	const publishers = new Map<string, readonly McpServerStatus[]>();
	events.emit(REQUEST_STATUS, (publisher: string, servers: readonly McpServerStatus[]) =>
		publishers.set(publisher, servers),
	);
	const merged = new Map<string, McpServerStatus>();
	for (const [publisher, servers] of publishers) {
		if (publisher === "configured") continue;
		for (const server of servers) merged.set(server.name, { ...server });
	}
	for (const server of publishers.get("configured") ?? []) merged.set(server.name, { ...server });
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Each owner replaces only its own snapshot; configured servers take precedence over automatic ones. */
export function setMcpSessionStatus(events: EventBus, publisher: string, servers: readonly McpServerStatus[]): void {
	let publishers = publishersByOwner.get(events);
	if (!publishers) {
		publishers = new Map<string, readonly McpServerStatus[]>();
		publishersByOwner.set(events, publishers);
		const owned = publishers;
		events.on(REQUEST_STATUS, (reply) => {
			if (typeof reply !== "function") return;
			for (const [name, snapshot] of owned) reply(name, snapshot);
		});
	}
	publishers.set(
		publisher,
		servers.map((server) => ({ ...server })),
	);
	events.emit(MCP_STATUS_EVENT, getMcpSessionStatus(events));
}
