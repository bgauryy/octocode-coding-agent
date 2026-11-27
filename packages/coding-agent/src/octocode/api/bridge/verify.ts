import { randomUUID } from "node:crypto";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { ApiClient } from "../client.ts";
import { MESSAGE_KEY_MAX } from "../protocol.ts";
import { claimedInstance, sameRecord } from "../registry-integrity.ts";
import { apiDir, type InstanceRecord, instancesStamp, recordStamp } from "../registry.ts";
import type { Connection } from "../server.ts";
import type { CallerClaim, ExternalFacts } from "./caller.ts";

/** What a proof rests on: the receiver it was given to, the record it confirmed, the registry as it was (`stampOf`) when it was last checked, and what that said. */
interface Proof {
	self: InstanceRecord;
	record: InstanceRecord;
	stamp: string;
	sharedName: boolean;
}

/**
 * The registry as a proof of `instanceId` last saw it, in two stats: the instances folder's mtime (a record added,
 * replaced or removed) and that instance's own file's (a record overwritten in place, which leaves the folder alone).
 */
const stampOf = (instanceId: string): string => `${instancesStamp(apiDir())}:${recordStamp(apiDir(), instanceId)}`;

/**
 * The claims each connection proved, by `instanceId\0pid`: a proof lasts as long as the connection it came on, and while
 * the registry still agrees on the instance. A change to the instances folder or to the instance's own file checks that
 * again before the proof counts, and the instance's own file must still hold the record that confirmed it.
 */
const proven = new WeakMap<Connection, Map<string, Proof>>();

const claimKey = (claim: CallerClaim): string | undefined =>
	claim.instanceId === undefined || claim.pid === undefined ? undefined : `${claim.instanceId}\0${claim.pid}`;

/** The connection's proof of `claim`, dropped when a changed registry no longer agrees on that instance or on the receiver, or names another record for it. */
function proofOf(connection: Connection, claim: CallerClaim): Proof | undefined {
	const key = claimKey(claim);
	const proofs = key === undefined ? undefined : proven.get(connection);
	const proof = key === undefined ? undefined : proofs?.get(key);
	if (!proof || key === undefined) return undefined;
	const stamp = stampOf(claim.instanceId!);
	if (stamp === proof.stamp) return proof;
	const still = claimedInstance(apiDir(), claim, proof.self);
	if (!still || !sameRecord(still.record, proof.record)) {
		proofs?.delete(key);
		return undefined;
	}
	proof.stamp = stamp;
	proof.sharedName = still.sharedName;
	return proof;
}

/** Whether this connection already proved `claim`: what a read records, without a call back. */
export function provenOn(connection: Connection, claim: CallerClaim): boolean {
	return proofOf(connection, claim) !== undefined;
}

/** The ticket a caller put in its claim (`api/identity.ts`): passed back to the claimed instance, never shown or recorded. */
function ticketFrom(params: Record<string, unknown>): string | undefined {
	const ticket = isRecord(params.caller) ? params.caller.ticket : undefined;
	return typeof ticket === "string" && ticket.length > 0 && ticket.length <= MESSAGE_KEY_MAX ? ticket : undefined;
}

const confirmed = (facts: ExternalFacts, sharedName: boolean): ExternalFacts => ({
	...facts,
	verified: true,
	...(sharedName ? { sharedName } : {}),
});

/**
 * Whether the running instance a caller names made this call itself. A Unix socket does not say who is on its other end,
 * and an instance's pid and id are in the readable registry, so the claim alone proves nothing. This calls the named
 * instance back on its own registered socket (`identity.confirm`) with the ticket the caller sent, this receiver's id and
 * endpoint, and a random nonce; only the process that issued that ticket for a call to this instance at this endpoint
 * (`self`, the receiver's own record) echoes the nonce. Anything else (no ticket, the instance offline, a registry that disagrees about it or about `self`
 * (`registry-integrity.ts`), no answer within `timeoutMs`, a wrong nonce) leaves the caller unverified, so its message is
 * asked about as any other caller's, or refused with nobody to ask: never allowed by a process grant.
 */
export async function verifyCaller(
	facts: ExternalFacts,
	params: Record<string, unknown>,
	connection: Connection,
	self: InstanceRecord | undefined,
	timeoutMs?: number,
): Promise<ExternalFacts> {
	const key = claimKey(facts);
	if (!facts.replyTo || key === undefined) return facts;
	const cached = proofOf(connection, facts);
	if (cached) return confirmed(facts, cached.sharedName);
	const ticket = ticketFrom(params);
	if (!ticket || !self) return facts;
	const stamp = stampOf(facts.instanceId!);
	const claimed = claimedInstance(apiDir(), facts, self);
	if (!claimed) return facts;
	const nonce = randomUUID();
	try {
		const answer = await new ApiClient(claimed.record).call(
			"identity.confirm",
			{ nonce, ticket, to: self.id, via: self.socket ?? self.http?.url },
			timeoutMs === undefined ? {} : { timeoutMs },
		);
		if (!isRecord(answer) || answer.nonce !== nonce) return facts;
	} catch {
		return facts;
	}
	const proofs = proven.get(connection) ?? new Map<string, Proof>();
	proofs.set(key, { self, record: claimed.record, stamp, sharedName: claimed.sharedName });
	proven.set(connection, proofs);
	return confirmed(facts, claimed.sharedName);
}
