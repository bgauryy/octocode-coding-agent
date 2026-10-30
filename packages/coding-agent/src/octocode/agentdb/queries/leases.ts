import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../rows.ts";

/** The unexpired leases of `workspace`, oldest first. */
export function live(db: DatabaseSync, workspace: string, now: number): Row[] {
	return db.prepare("SELECT * FROM leases WHERE workspace = ? AND expires_at > ? ORDER BY id").all(workspace, now);
}

/**
 * The first live lease of another owner than `self` that blocks `key`: the same key, a tree above it (`ancestors` are
 * the keys of the directories above), or (for a tree request) anything below it. Component boundaries, not string prefixes.
 */
export function conflicting(
	db: DatabaseSync,
	workspace: string,
	self: string,
	now: number,
	key: string,
	ancestors: string[],
	kind: "file" | "tree",
): Row | undefined {
	const marks = ancestors.map(() => "?").join(",");
	return db
		.prepare(
			`SELECT * FROM leases WHERE workspace = ? AND owner <> ? AND expires_at > ? AND
         (path_key = ? OR (kind = 'tree' AND path_key IN (${marks})) OR (? = 'tree' AND path_key > ? AND path_key < ?)) ORDER BY id LIMIT 1`,
		)
		.get(workspace, self, now, key, ...ancestors, kind, `${key}/`, `${key}0`);
}

/** The id of the live lease `owner` holds on `key` of this kind. */
export function heldId(
	db: DatabaseSync,
	workspace: string,
	owner: string,
	key: string,
	kind: string,
	now: number,
): number | undefined {
	const row = db
		.prepare("SELECT id FROM leases WHERE workspace = ? AND owner = ? AND path_key = ? AND kind = ? AND expires_at > ?")
		.get(workspace, owner, key, kind, now) as Row | undefined;
	return row ? num(row.id) : undefined;
}

export interface NewLease {
	path: string;
	pathKey: string;
	kind: string;
	reason: string;
}

/** Adds a lease of `owner` acquired at `now` that expires at `expiresAt`. */
export function insert(
	db: DatabaseSync,
	workspace: string,
	owner: string,
	lease: NewLease,
	now: number,
	expiresAt: number,
): void {
	db.prepare(
		"INSERT INTO leases (workspace, path, path_key, kind, owner, reason, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(workspace, lease.path, lease.pathKey, lease.kind, owner, lease.reason, now, expiresAt);
}

/** Renews lease `id` with a new reason and expiry. */
export function renew(db: DatabaseSync, id: number, reason: string, expiresAt: number): void {
	db.prepare("UPDATE leases SET reason = ?, expires_at = ? WHERE id = ?").run(reason, expiresAt, id);
}

/** Deletes every lease of `owner`; how many. */
export function releaseByOwner(db: DatabaseSync, owner: string): number {
	return Number(db.prepare("DELETE FROM leases WHERE owner = ?").run(owner).changes);
}

/** Deletes `owner`'s lease on `key`; how many. */
export function releaseKey(db: DatabaseSync, workspace: string, owner: string, key: string): number {
	return Number(
		db.prepare("DELETE FROM leases WHERE workspace = ? AND owner = ? AND path_key = ?").run(workspace, owner, key)
			.changes,
	);
}

/** Deletes the leases of `owner` that lapsed by `now`. */
export function dropLapsed(db: DatabaseSync, owner: string, now: number): void {
	db.prepare("DELETE FROM leases WHERE owner = ? AND expires_at <= ?").run(owner, now);
}

/** Sets the expiry of every lease of `owner`. */
export function extendOwner(db: DatabaseSync, owner: string, expiresAt: number): void {
	db.prepare("UPDATE leases SET expires_at = ? WHERE owner = ?").run(expiresAt, owner);
}

/** Leases of `workspace` not yet expired at `since` expire no earlier than `expiresAt`. */
export function extendLiveSince(db: DatabaseSync, workspace: string, since: number, expiresAt: number): void {
	db.prepare("UPDATE leases SET expires_at = MAX(expires_at, ?) WHERE workspace = ? AND expires_at > ?").run(
		expiresAt,
		workspace,
		since,
	);
}

/** Deletes every lease that expired before `now`. */
export function pruneExpired(db: DatabaseSync, now: number): void {
	db.prepare("DELETE FROM leases WHERE expires_at < ?").run(now);
}
