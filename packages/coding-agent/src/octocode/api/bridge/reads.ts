import type { Connection } from "../server.ts";
import { callerFrom } from "./caller.ts";
import { provenOn } from "./verify.ts";

/**
 * Records a read of the session (`status`, `messages.list`, an event stream, `agents.list`, `external.call` `list`) in the session's
 * `octocode-external` entries, naming the caller as it claims itself and whether its connection proved that claim. Reads
 * stay open to any process of this user, so the user's own tools keep working unasked; the record says who looked.
 */
export function recordRead(
	audit: (data: Record<string, unknown>) => void,
	method: string,
	params: Record<string, unknown>,
	connection: Connection,
): void {
	const caller = callerFrom(params);
	audit({
		method,
		read: true,
		caller,
		callerVerified: provenOn(connection, caller),
		...(connection.transport ? { transport: connection.transport } : {}),
	});
}
