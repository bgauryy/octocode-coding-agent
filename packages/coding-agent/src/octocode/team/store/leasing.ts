import path from "node:path";
import { type Db, leases } from "../../../../../db/src/api.ts";
import { ancestorKeys, overlappingRequests } from "../lease-key.ts";
import { type Lease, type LeaseRequest, toLease } from "../model.ts";
import { LEASE_MS } from "./limits.ts";
import { type NestedCheck, nestedChecks } from "./nested.ts";
import { canonicalIn, pathKey } from "./workspace.ts";

/** The lease rows behind `TeamStore` (`store.ts`); each is described on the `TeamStore` method that runs it. */

export function liveLeases(db: Db, workspace: string, now: number): Lease[] {
	return leases.live(db, workspace, now).map(toLease);
}

/** The live leases of every agent of `team`, each path relative to its owner's checkout (`TeamStore.teamLeases`). */
export function teamLeases(db: Db, team: string, now: number): Lease[] {
	return leases.liveInTeam(db, team, now).map(toLease);
}

/**
 * The live lease of another owner that blocks `file` in `workspace`: one in this checkout, or one in a checkout of `team`
 * nested with it that names the same file (`nestedChecks`). `retireOwner` retires a lease owner that is gone and says
 * whether it did (`TeamStore.retireOwner`).
 */
export function conflictingLease(
	db: Db,
	team: string,
	workspace: string,
	file: string,
	self: string,
	kind: "file" | "tree",
	now: number,
	retireOwner: (owner: string, now: number) => boolean,
): Lease | undefined {
	// Every check below looks for another owner's live lease: with none anywhere, no path or checkout needs resolving.
	if (!leases.anyLiveOfOthers(db, self, now)) return undefined;
	const key = pathKey(workspace, file);
	const checks: NestedCheck[] = [{ workspace, key, kind }, ...nestedChecks(db, team, workspace, key, kind, now)];
	for (const check of checks) {
		const ancestors = ancestorKeys(check.key);
		for (;;) {
			const row = leases.conflicting(db, check.workspace, self, now, check.key, ancestors, check.kind);
			if (!row) break;
			const lease = toLease(row);
			// A crashed owner (killed, never left) frees its files now rather than when the lease runs out; a stalled one
			// (alive, silent) keeps them until they lapse, since its process may resume.
			if (!retireOwner(lease.owner, now)) return lease;
		}
	}
	return undefined;
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
export function writeLeases(
	db: Db,
	workspace: string,
	workspaceId: string,
	owner: string,
	requests: LeaseRequest[],
	now: number,
): void {
	for (const request of requests) {
		const relative = path.relative(workspace, canonicalIn(workspace, request.path)) || ".";
		const key = pathKey(workspace, request.path);
		const existing = leases.heldId(db, workspace, owner, key, request.kind, now);
		if (existing !== undefined) leases.renew(db, existing, request.reason, now + LEASE_MS);
		else
			leases.insert(
				db,
				workspaceId,
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

/** Leases of the team's agents not yet expired at `since` get a fresh start from `now` (`TeamStore.resume`). */
export function resumeLeases(db: Db, team: string, since: number, now: number): void {
	leases.extendTeamLiveSince(db, team, since, now + LEASE_MS);
}
