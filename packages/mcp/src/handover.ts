/**
 * Connections a replaced session hands to the next session of this process (`/new`, `/resume`, a fork), so a server
 * whose launch did not change keeps its process instead of being stopped and started again. A handed connection is
 * only reused when everything that shaped its launch is the same: the server's entry, the session folder, project
 * trust, the host options that build connections, and the launch the new session computes once its resources are known
 * (`startup-gate.ts`). Anything else closes it, as the replaced session would have: a stopped, failed, busy or
 * signing-in connection, a server with a preset that cleans up after its session (`dispose`), a server the next session
 * does not start, a launch that differs, and every connection still held when a session ends for good (`quit`) or the
 * next session starts without them. Reuse is never required: closing is always the safe answer.
 */

import { isDeepStrictEqual } from "node:util";
import type { McpServerEntry } from "./config.ts";
import type { McpServerConnection } from "./runtime.ts";
import { isEnabled, type McpServer } from "./server.ts";
import type { McpExtensionOptions, McpExtensionState } from "./state.ts";

/** The session a connection reports to. A handed connection is rebound to the session that takes it. */
export interface ConnectionOwner {
	state: McpExtensionState;
	isCurrent: () => boolean;
}

const owners = new WeakMap<McpServerConnection, ConnectionOwner>();

export function bindOwner(connection: McpServerConnection, owner: ConnectionOwner): void {
	owners.set(connection, owner);
}

/** A connection between the session that handed it over and the one that may take it. */
export interface HandedConnection {
	connection: McpServerConnection;
	entry: McpServerEntry;
	cwd: string;
	trusted: boolean;
	launched: McpServerEntry;
	options: McpExtensionOptions;
}

const handed = new Map<string, HandedConnection>();

/** Session ends that start another session in this process right after. */
const SWITCHES: ReadonlySet<unknown> = new Set(["new", "resume", "fork"]);

/** Whether the next session could take `server`'s connection: connected, idle, chosen, and launched by this session. */
function handable(state: McpExtensionState, server: McpServer): HandedConnection | undefined {
	const connection = server.connection;
	const launched = connection && state.preparedLaunches.get(connection);
	if (!connection || !launched || !isEnabled(server) || server.unselected) return undefined;
	if (connection.state !== "connected" || connection.isStopped || !connection.idle) return undefined;
	if (state.preset(server.entry)?.dispose) return undefined;
	if (!owners.has(connection)) return undefined;
	return {
		connection,
		entry: server.entry,
		cwd: state.sessionCwd,
		trusted: state.projectTrusted,
		launched,
		options: state.options,
	};
}

/** Close every connection still held: nothing takes it now. */
export function closeHanded(): Promise<void>[] {
	const closing = [...handed.values()].map(({ connection }) => connection.close());
	handed.clear();
	return closing;
}

/**
 * At `session_shutdown`: hold the connections the next session may take when the session is being replaced, and
 * return the ones to close now. Connections an earlier session held and nobody took close too.
 */
export function handOver(state: McpExtensionState, reason: unknown): { closing: Promise<void>[] } {
	const closing = closeHanded();
	const keep = SWITCHES.has(reason);
	for (const server of state.servers) {
		const connection = server.connection;
		if (!connection) continue;
		const held = keep ? handable(state, server) : undefined;
		if (held) {
			// The replaced session no longer hears from it; the session that takes it rebinds it.
			const owner = owners.get(connection);
			if (owner) owner.isCurrent = () => false;
			handed.set(server.entry.name, held);
		} else closing.push(connection.close());
	}
	return { closing };
}

/**
 * At `session_start`: the held connections of the servers this session starts, by name; the others close. Each taken
 * one is then either adopted (`adoptHanded`) or closed by the start that took it.
 */
export function takeHanded(starting: readonly McpServer[]): {
	taken: Map<string, HandedConnection>;
	closing: Promise<void>[];
} {
	const names = new Set(starting.map((server) => server.entry.name));
	const taken = new Map<string, HandedConnection>();
	const closing: Promise<void>[] = [];
	for (const [name, held] of handed) {
		if (names.has(name)) taken.set(name, held);
		else closing.push(held.connection.close());
	}
	handed.clear();
	return { taken, closing };
}

/** The host options that build a connection, which must be the very same for a connection to change sessions. */
function sameHost(a: McpExtensionOptions, b: McpExtensionOptions): boolean {
	return a.credentials === b.credentials && a.createTransport === b.createTransport && a.logPath === b.logPath;
}

/** Whether `held` is the connection `server` would launch now in `state`; a launch that cannot be prepared does not match. */
function matches(state: McpExtensionState, server: McpServer, held: HandedConnection): boolean {
	const { connection } = held;
	if (connection.state !== "connected" || connection.isStopped || !connection.idle) return false;
	if (held.cwd !== state.sessionCwd || held.trusted !== state.projectTrusted) return false;
	if (!sameHost(held.options, state.options) || !isDeepStrictEqual(held.entry, server.entry)) return false;
	try {
		return isDeepStrictEqual(held.launched, state.prepareLaunch(server.entry, state.sessionCwd));
	} catch {
		return false;
	}
}

/**
 * Adopt `held` as `server`'s connection in `state` when it matches the launch this session computes now. Returns the
 * adopted connection, or undefined when the caller must close `held` and launch afresh.
 */
export function adoptHanded(
	state: McpExtensionState,
	server: McpServer,
	held: HandedConnection,
	isCurrent: () => boolean,
): McpServerConnection | undefined {
	const owner = owners.get(held.connection);
	if (!owner || !matches(state, server, held)) return undefined;
	owner.state = state;
	owner.isCurrent = isCurrent;
	state.preparedLaunches.set(held.connection, held.launched);
	return held.connection;
}

/** Test seam: how many connections are held between sessions. */
export const handedCount = (): number => handed.size;
