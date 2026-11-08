import { randomUUID } from "node:crypto";
import { ERR, MESSAGE_KEY_MAX, RpcError, stringParam } from "./protocol.ts";
import type { InstanceRecord } from "./registry.ts";

/** The longest endpoint (a socket path or a loopback URL) `identity.confirm` accepts. */
const ENDPOINT_MAX = 1024;

/**
 * This process's own API record, as its API wrote it: what this process's calls claim to be. Any process of the user
 * can write a record with this pid into the registry, so the claim comes from here, never from a registry lookup.
 */
let own: InstanceRecord | undefined;

/** The record this process's API published, if it serves one. */
export const ownInstance = (): InstanceRecord | undefined => own;

/** The API publishes its record on start (`record`) and withdraws it on stop (`undefined`, only when it is still `was`). */
export function publishOwnInstance(record: InstanceRecord | undefined, was?: InstanceRecord): void {
	if (record || own === was) own = record;
}

/**
 * The tickets of this process's calls in flight to other sessions, so a receiver can check who called it. A caller puts a
 * fresh ticket in its `caller` claim; the receiver calls the claimed instance back on that instance's own registered socket
 * (`identity.confirm`) with the ticket, its own id and endpoint, and a random nonce, and only the process that issued the
 * ticket for a call to that id at that endpoint echoes the nonce. Another process of the same user can copy an instance's
 * pid and id from the registry, but not a ticket that lives only in this process's memory and in the private call it
 * sent; and a ticket it collects by pointing a receiver's record at its own socket names that socket, not the receiver's.
 */
const live = new Map<string, { to: string; via: string | undefined }>();

/**
 * A ticket for a call to the instance `to` at the endpoint `via` (the socket path or URL the call goes to); `release`
 * once the call (and any follow-up with the same params) is over.
 */
export function issueTicket(to: string, via: string | undefined): { ticket: string; release(): void } {
	const ticket = randomUUID();
	live.set(ticket, { to, via });
	return { ticket, release: () => live.delete(ticket) };
}

/** Whether this process holds `ticket` for a call to `to` at `via`. */
function holdsTicket(ticket: string, to: string, via: string): boolean {
	const held = live.get(ticket);
	return held !== undefined && held.to === to && held.via === via;
}

/**
 * `identity.confirm`: echoes `nonce` when this process holds `ticket` for a call to the instance `to` at the endpoint
 * `via`, and refuses otherwise.
 */
export function confirmIdentity(params: Record<string, unknown>): { nonce: string } {
	const nonce = stringParam(params, "nonce", { max: MESSAGE_KEY_MAX })!;
	const ticket = stringParam(params, "ticket", { max: MESSAGE_KEY_MAX })!;
	const to = stringParam(params, "to", { max: MESSAGE_KEY_MAX })!;
	const via = stringParam(params, "via", { max: ENDPOINT_MAX })!;
	if (!holdsTicket(ticket, to, via))
		throw new RpcError(ERR.invalidParams, "This process has no call in flight with that ticket");
	return { nonce };
}
