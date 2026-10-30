import path from "node:path";
import { type Db, leases } from "../../agentdb/api.ts";
import { ancestorKeys, overlappingRequests } from "../lease-key.ts";
import { type Lease, type LeaseRequest, toLease } from "../model.ts";
import { LEASE_MS } from "./limits.ts";
import { canonicalIn, pathKey } from "./workspace.ts";

/** The lease rows behind `TeamStore` (`store.ts`); each is described on the `TeamStore` method that runs it. */

export function liveLeases(db: Db, workspace: string, now: number): Lease[] {
	return leases.live(db, workspace, now).map(toLease);
}

/** `retireOwner` retires a lease owner that is gone and says whether it did (`TeamStore.retireOwner`). */
export function conflictingLease(
	db: Db,
	workspace: string,
	file: string,
	self: string,
	kind: "file" | "tree",
	now: number,
	retireOwner: (owner: string, now: number) => boolean,
): Lease | undefined {
	const key = pathKey(workspace, file);
	const ancestors = ancestorKeys(key);
	for (;;) {
		const row = leases.conflicting(db, workspace, self, now, key, ancestors, kind);
		if (!row) return undefined;
		const lease = toLease(row);
		// A crashed owner (killed, never left) frees its files now rather than when the lease runs out; a stalled one
		// (alive, silent) keeps them until they lapse, since its process may resume.
		if (!retireOwner(lease.owner, now)) return lease;
	}
}

/** Throws when the requests overlap each other (see `TeamStore.lock`). */
export function refuseOverlap(workspace: string, requests: LeaseRequest[]): void {
	const overlap = overlappingRequests(
		requests.map((request) => ({ ...request, key: pathKey(workspace, request.path) })),
	);
	if (overlap) {
		const shown = (request: LeaseRequest) => path.relative(workspace, canonicalIn(workspace, request.path)) || ".";
		throw new Error(
			`Requested paths overlap: ${shown(overlap[0])} and ${shown(overlap[1])}. Nothing was locked; reserve the tree alone, or each path once.`,
		);
	}
}

/** Writes `owner`'s lease for each request (a live one it already holds is renewed with the new reason). */
export function writeLeases(db: Db, workspace: string, owner: string, requests: LeaseRequest[], now: number): void {
	for (const request of requests) {
		const relative = path.relative(workspace, canonicalIn(workspace, request.path)) || ".";
		const key = pathKey(workspace, request.path);
		const existing = leases.heldId(db, workspace, owner, key, request.kind, now);
		if (existing !== undefined) leases.renew(db, existing, request.reason, now + LEASE_MS);
		else
			leases.insert(
				db,
				workspace,
				owner,
				{ path: relative, pathKey: key, kind: request.kind, reason: request.reason },
				now,
				now + LEASE_MS,
			);
	}
}

export function releaseLeases(db: Db, workspace: string, owner: string, paths?: string[]): number {
	if (!paths || paths.length === 0) return leases.releaseByOwner(db, owner);
	return paths.reduce((count, file) => count + leases.releaseKey(db, workspace, owner, pathKey(workspace, file)), 0);
}

/** Leases not yet expired at `since` get a fresh start from `now` (`TeamStore.resume`). */
export function resumeLeases(db: Db, workspace: string, since: number, now: number): void {
	leases.extendLiveSince(db, workspace, since, now + LEASE_MS);
}
