/**
 * Which pending restored tools belong to an MCP server that may still register them. Core learns the
 * server state from the session's MCP status snapshot, which the MCP host publishes on the event bus.
 */

import { isMcpToolName } from "../../../../mcp/src/servers.ts";
import { mcpNamespace } from "../../../../common/src/mcp-names.ts";
import { getMcpSessionStatus, MCP_STATUS_EVENT, type McpServerStatus } from "../../../../mcp/src/status.ts";
import type { EventBus } from "@octocodeai/octocode-agent-core";

/** The status of the server that owns the MCP tool: the one with the longest matching namespace. */
function serverOf(toolName: string, servers: readonly McpServerStatus[]): McpServerStatus | undefined {
	let owner: McpServerStatus | undefined;
	let length = -1;
	for (const server of servers) {
		const prefix = `${mcpNamespace(server.name)}__`;
		if (toolName.startsWith(prefix) && prefix.length > length) {
			owner = server;
			length = prefix.length;
		}
	}
	return owner;
}

/** Whether a tool of this server can still register: it is connecting or connected. */
function mayRegister(server: McpServerStatus | undefined, connectedCounts: boolean): boolean {
	if (!server?.enabled) return false;
	return (
		server.state === "starting" || server.state === "connecting" || (connectedCounts && server.state === "connected")
	);
}

/** The MCP tools among `names` whose server is still connecting, so they may register later. */
function startingMcpTools(names: Iterable<string>, events: EventBus): string[] {
	const servers = getMcpSessionStatus(events);
	return [...names].filter((name) => isMcpToolName(name) && mayRegister(serverOf(name, servers), false));
}

/**
 * Pending restored tools that survive the start of a run: the MCP tools whose server is still
 * connecting. They are dropped when that server fails, stops or is disabled, or once they are no longer pending.
 */
export class PendingMcpTools {
	private unwatch?: () => void;

	/** Drop every pending tool except MCP tools of connecting servers, and watch those servers. */
	retain(pending: () => Set<string>, events: EventBus | undefined): void {
		this.dispose();
		const names = pending();
		const keep = new Set(events ? startingMcpTools(names, events) : []);
		for (const name of names) if (!keep.has(name)) names.delete(name);
		if (!events || keep.size === 0) return;
		this.unwatch = events.on(MCP_STATUS_EVENT, () => {
			const current = pending();
			const servers = getMcpSessionStatus(events);
			for (const name of current) {
				if (isMcpToolName(name) && !mayRegister(serverOf(name, servers), true)) current.delete(name);
			}
			if (![...current].some(isMcpToolName)) this.dispose();
		});
	}

	dispose(): void {
		this.unwatch?.();
		this.unwatch = undefined;
	}
}
