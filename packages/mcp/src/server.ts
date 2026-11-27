import { firstLine } from "@octocodeai/octocode-common/clip";
import type { McpServerEntry } from "./config.ts";
import type { McpServerConnection } from "./runtime.ts";

/** A configured server. Disabled servers have no connection. */
export interface McpServer {
	entry: McpServerEntry;
	connection?: McpServerConnection;
	/** For servers features registered: the config as registered, to detect re-registrations. */
	registeredConfig?: string;
	/** Result of the last `/mcp` action that failed, shown in the manager. */
	message?: string;
	/** Identifies the current connection attempt; disabling or replacing it invalidates earlier work. */
	attempt?: symbol;
	/** Settles when the connection started for the server connected or failed. */
	ready?: Promise<void>;
	/** Cleanup of a detached connection; a replacement waits for it before opening a transport. */
	closing?: Promise<void>;
	/**
	 * No tool selection of this session reaches the server (`defaultActive: false` and no selector names its tools), so
	 * it was not started. A start that chooses it for the session (enabling it from `/mcp`) clears this; a hook's does not.
	 */
	unselected?: boolean;
}

/** How every view words a server the security review holds back: off, whatever its switch says, until approved. */
export const WITHHELD_STATE = "not checked: off until you approve it in /security";

export function isEnabled(server: Pick<McpServer, "entry">): boolean {
	return server.entry.config.enabled !== false && !server.entry.withheld;
}

/** Short state for lists and the startup report. `withError` appends the first line of a failure. */
export function describeState(server: McpServer, withError = true): string {
	if (server.entry.withheld) return WITHHELD_STATE;
	if (!isEnabled(server)) return "disabled";
	const connection = server.connection;
	if (!connection) return server.unselected ? "not selected" : "starting";
	// A start that timed out was tried once more with a longer timeout; the state says so.
	const retried = connection.retriedAfterTimeout ? " (retried after timeout)" : "";
	switch (connection.state) {
		case "needs-auth":
			return "needs sign-in";
		case "failed":
			return (withError ? `failed: ${firstLine(connection.error ?? "unknown error")}` : "failed") + retried;
		case "connected": {
			const { tools } = connection;
			return `connected · ${tools.length} tool${tools.length === 1 ? "" : "s"}${retried}`;
		}
		case "connecting":
			return "connecting…";
		default:
			return connection.state;
	}
}

/**
 * How soon a server in connection `state` needs the user: sign-in first, then a failed start, a lost connection, one
 * not started or starting, a connected one, and a switched-off one (`enabled` false) last.
 */
function stateRank(enabled: boolean, state: string | undefined): number {
	if (!enabled) return 5;
	switch (state) {
		case "needs-auth":
			return 0;
		case "failed":
			return 1;
		case "disconnected":
			return 2;
		case "connected":
			return 4;
		default:
			return 3;
	}
}

/** A server as a list orders it: its name, whether it is switched on (`isEnabled`) and its connection state. */
interface ServerOrderKey {
	name: string;
	enabled: boolean;
	state: string | undefined;
}

/**
 * The one order of server lists (the `/mcp` page, `/mcp list`, `octocode mcp list`): servers that need the user
 * first, then by name.
 */
export function compareServerOrder(a: ServerOrderKey, b: ServerOrderKey): number {
	return stateRank(a.enabled, a.state) - stateRank(b.enabled, b.state) || a.name.localeCompare(b.name);
}

/** A session's servers in the order lists show them (`compareServerOrder`). */
export function inServerOrder(servers: readonly McpServer[]): McpServer[] {
	const key = (server: McpServer): ServerOrderKey => ({
		name: server.entry.name,
		enabled: isEnabled(server),
		state: server.connection?.state,
	});
	return [...servers].sort((a, b) => compareServerOrder(key(a), key(b)));
}

export function describeTransport(entry: McpServerEntry): string {
	const { config } = entry;
	if (!("url" in config)) return config.command;
	const url = new URL(config.url);
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	return url.href;
}
