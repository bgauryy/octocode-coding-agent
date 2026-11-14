import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../rows.ts";
import { keptStatement } from "../statements.ts";

/** The unexpired leases of `workspace`, oldest first. */
export function live(db: DatabaseSync, workspace: string, now: number): Row[] {
	return keptStatement(
		db,
		"SELECT * FROM leases WHERE workspace_id IN (SELECT id FROM workspaces WHERE root = ?) AND expires_at > ? ORDER BY id",
	).all(workspace, now);
}

/** Whether an owner other than `self` holds any unexpired lease, in any checkout: without one, nothing can conflict. */
export function anyLiveOfOthers(db: DatabaseSync, self: string, now: number): boolean {
	return (
		keptStatement(db, "SELECT 1 FROM leases WHERE owner <> ? AND expires_at > ? LIMIT 1").get(self, now) !== undefined
	);
}

/**
 * The unexpired leases held by the agents of `team`, whatever checkout they lock in, oldest first. Each path is relative
 * to the protected workspace's root, so these are for showing, never for conflict checks (`conflicting`).
 */
export function liveInTeam(db: DatabaseSync, team: string, now: number): Row[] {
	return db
		.prepare(
			"SELECT l.* FROM leases l JOIN agents a ON a.id = l.owner WHERE a.team = ? AND l.expires_at > ? ORDER BY l.id",
		)
		.all(team, now);
}

/** The checkouts other than `workspace` where agents of `team` hold an unexpired lease. */
export function checkoutsInTeam(db: DatabaseSync, team: string, workspace: string, now: number): string[] {
	return keptStatement(
		db,
		"SELECT DISTINCT w.root FROM leases l JOIN workspaces w ON w.id = l.workspace_id JOIN agents a ON a.id = l.owner WHERE a.team = ? AND w.root <> ? AND l.expires_at > ?",
	)
		.all(team, workspace, now)
		.map((row) => String(row.root));
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
	// One SQL text per number of ancestors (the path's depth): a few kept statements.
	return keptStatement(
		db,
		`SELECT * FROM leases WHERE workspace_id IN (SELECT id FROM workspaces WHERE root = ?) AND owner <> ? AND expires_at > ? AND
         (path_key = ? OR (kind = 'tree' AND path_key IN (${marks})) OR (? = 'tree' AND path_key > ? AND path_key < ?)) ORDER BY id LIMIT 1`,
	).get(workspace, self, now, key, ...ancestors, kind, `${key}/`, `${key}0`);
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
		.prepare(
			"SELECT id FROM leases WHERE workspace_id IN (SELECT id FROM workspaces WHERE root = ?) AND owner = ? AND path_key = ? AND kind = ? AND expires_at > ?",
		)
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
	workspaceId: string,
	owner: string,
	lease: NewLease,
	now: number,
	expiresAt: number,
): void {
	db.prepare(
		"INSERT INTO leases (workspace_id, path, path_key, kind, owner, reason, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(workspaceId, lease.path, lease.pathKey, lease.kind, owner, lease.reason, now, expiresAt);
}

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
		db
			.prepare(
				"DELETE FROM leases WHERE workspace_id IN (SELECT id FROM workspaces WHERE root = ?) AND owner = ? AND path_key = ?",
			)
			.run(workspace, owner, key).changes,
	);
}

export function dropLapsed(db: DatabaseSync, owner: string, now: number): void {
	db.prepare("DELETE FROM leases WHERE owner = ? AND expires_at <= ?").run(owner, now);
}

/** Sets the expiry of every lease of `owner`. */
export function extendOwner(db: DatabaseSync, owner: string, expiresAt: number): void {
	db.prepare("UPDATE leases SET expires_at = ? WHERE owner = ?").run(expiresAt, owner);
}

/** Leases held by agents of `team` (in any of its checkouts) not yet expired at `since` expire no earlier than `expiresAt`. */
export function extendTeamLiveSince(db: DatabaseSync, team: string, since: number, expiresAt: number): void {
	db.prepare(
		"UPDATE leases SET expires_at = MAX(expires_at, ?) WHERE expires_at > ? AND owner IN (SELECT id FROM agents WHERE team = ?)",
	).run(expiresAt, since, team);
}

/** Deletes every lease that expired before `now`. */
export function pruneExpired(db: DatabaseSync, now: number): void {
	db.prepare("DELETE FROM leases WHERE expires_at < ?").run(now);
}
