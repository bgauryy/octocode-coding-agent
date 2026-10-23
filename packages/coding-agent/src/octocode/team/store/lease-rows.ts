import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../../agentdb/rows.ts";
import { canonicalPath } from "../../shared/home.ts";
import { ancestorKeys, overlappingRequests } from "../lease-key.ts";
import { type Lease, type LeaseRequest, toLease } from "../model.ts";
import { LEASE_MS } from "./limits.ts";
import { pathKey } from "./workspace.ts";

/** The lease rows behind `TeamStore` (`store.ts`); each is described on the `TeamStore` method that runs it. */

export function liveLeases(db: DatabaseSync, workspace: string, now: number): Lease[] {
	return (
		db.prepare("SELECT * FROM leases WHERE workspace = ? AND expires_at > ? ORDER BY id").all(workspace, now) as Row[]
	).map(toLease);
}

/** `retireOwner` retires a lease owner that is gone and says whether it did (`TeamStore.retireOwner`). */
export function conflictingLease(
	db: DatabaseSync,
	workspace: string,
	file: string,
	self: string,
	kind: "file" | "tree",
	now: number,
	retireOwner: (owner: string, now: number) => boolean,
): Lease | undefined {
	const key = pathKey(workspace, file);
	const ancestors = ancestorKeys(key);
	const marks = ancestors.map(() => "?").join(",");
	// Same key, a tree above it, or (for a tree request) anything below it. Component boundaries, not string prefixes.
	const query = db.prepare(
		`SELECT * FROM leases WHERE workspace = ? AND owner <> ? AND expires_at > ? AND
         (path_key = ? OR (kind = 'tree' AND path_key IN (${marks})) OR (? = 'tree' AND path_key > ? AND path_key < ?)) ORDER BY id LIMIT 1`,
	);
	for (;;) {
		const row = query.get(workspace, self, now, key, ...ancestors, kind, `${key}/`, `${key}0`) as Row | undefined;
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
		const shown = (request: LeaseRequest) =>
			path.relative(workspace, canonicalPath(path.resolve(workspace, request.path))) || ".";
		throw new Error(
			`Requested paths overlap: ${shown(overlap[0])} and ${shown(overlap[1])}. Nothing was locked; reserve the tree alone, or each path once.`,
		);
	}
}

/** Writes `owner`'s lease for each request (a live one it already holds is renewed with the new reason). */
export function writeLeases(
	db: DatabaseSync,
	workspace: string,
	owner: string,
	requests: LeaseRequest[],
	now: number,
): void {
	const find = db.prepare(
		"SELECT id FROM leases WHERE workspace = ? AND owner = ? AND path_key = ? AND kind = ? AND expires_at > ?",
	);
	const insert = db.prepare(
		"INSERT INTO leases (workspace, path, path_key, kind, owner, reason, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const touch = db.prepare("UPDATE leases SET reason = ?, expires_at = ? WHERE id = ?");
	for (const request of requests) {
		const relative = path.relative(workspace, canonicalPath(path.resolve(workspace, request.path))) || ".";
		const key = pathKey(workspace, request.path);
		const existing = find.get(workspace, owner, key, request.kind, now) as Row | undefined;
		if (existing) touch.run(request.reason, now + LEASE_MS, num(existing.id));
		else insert.run(workspace, relative, key, request.kind, owner, request.reason, now, now + LEASE_MS);
	}
}

export function releaseLeases(db: DatabaseSync, workspace: string, owner: string, paths?: string[]): number {
	if (!paths || paths.length === 0) return Number(db.prepare("DELETE FROM leases WHERE owner = ?").run(owner).changes);
	const remove = db.prepare("DELETE FROM leases WHERE workspace = ? AND owner = ? AND path_key = ?");
	return paths.reduce(
		(count, file) => count + Number(remove.run(workspace, owner, pathKey(workspace, file)).changes),
		0,
	);
}

/** Leases not yet expired at `since` get a fresh start from `now` (`TeamStore.resume`). */
export function resumeLeases(db: DatabaseSync, workspace: string, since: number, now: number): void {
	db.prepare("UPDATE leases SET expires_at = MAX(expires_at, ?) WHERE workspace = ? AND expires_at > ?").run(
		now + LEASE_MS,
		workspace,
		since,
	);
}
