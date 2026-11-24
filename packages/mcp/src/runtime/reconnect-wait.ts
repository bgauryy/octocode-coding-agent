/** The bounded wait of a tool call for a server that is reconnecting (`reconnectWaitMs` of its entry). */

import { setTimeout as sleep } from "node:timers/promises";
import { raceWithAbortSignal } from "@octocodeai/octocode-ai/utils/abort";
import type { McpServerConnection } from "../runtime.ts";

/** How long a call waits for a reconnect when the entry sets no `reconnectWaitMs`. */
const DEFAULT_RECONNECT_WAIT_MS = 5_000;

type ReconnectingConnection = Pick<McpServerConnection, "entry" | "state" | "rejectWhileDown" | "getClient">;

const settled = (): undefined => undefined;

/**
 * Why a call to `connection` fails, or undefined when it may proceed. A connection that is down fails the call, as
 * `rejectWhileDown` says, except while a connect is in progress (the one a drop starts, or one already running): the
 * call then waits for it, up to the entry's `reconnectWaitMs`, and proceeds when the server is back. A stopped, failed,
 * backed-off or signed-out server has no connect to wait for and fails at once. Aborting `signal` ends the wait by
 * throwing its reason; the connect goes on for the server's other callers. Costs one timer per waiting call.
 */
export async function downAfterReconnectWait(
	connection: ReconnectingConnection,
	signal: AbortSignal | undefined,
): Promise<Error | undefined> {
	const failure = connection.rejectWhileDown();
	const waitMs = connection.entry.config.reconnectWaitMs ?? DEFAULT_RECONNECT_WAIT_MS;
	// `connecting` is set for exactly as long as the shared connect runs, so `getClient()` below joins it and starts none.
	if (!failure || waitMs <= 0 || connection.state !== "connecting") return failure;
	const timer = new AbortController();
	try {
		await raceWithAbortSignal(
			Promise.race([
				connection.getClient().then(settled, settled),
				sleep(waitMs, undefined, { signal: timer.signal }).then(settled, settled),
			]),
			signal,
		);
	} finally {
		timer.abort();
	}
	return connection.rejectWhileDown();
}
