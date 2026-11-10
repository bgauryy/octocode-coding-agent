import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { allRows, num, type Row } from "../rows.ts";

/**
 * Folder trust: the user's decisions about folders (`trusted_folders`). A folder is identified by its file identity
 * (`dev`, `ino`, `birth`), not by its path, so a renamed or moved folder keeps its row and a new folder at an old path
 * does not inherit it; `path` is where the folder was last seen. `dev` is not stable everywhere: macOS numbers a volume
 * when it mounts, so after a reboot the same folder can report another `dev`. A row then still belongs to the folder when
 * its inode, recorded birth time and last-seen path all match (`sameFolder`), and the next open stores the new `dev`.
 * One live row per folder: a new decision revokes
 * the previous one and keeps it as history. Whether a row applies to a given folder is the resolver's decision
 * (`octocode/trust/resolve.ts`); these functions only read and write rows.
 */

export type FolderDecision = "trusted" | "refused";
/** `folder` covers the folder only; `subtree` covers it and everything under it. */
type FolderScope = "folder" | "subtree";

/** What identifies a folder: `dev` and `ino` as decimal text (exact for 64-bit values), `birth` as nanoseconds text or `"0"`. */
export interface FolderIdentity {
	dev: string;
	ino: string;
	birth: string;
}

export interface FolderGrantRow extends FolderIdentity {
	id: number;
	/** Where the folder was last seen; shown to the user, never used to match. */
	path: string;
	decision: FolderDecision;
	scope: FolderScope;
	/** How the decision was made: `prompt`, `command`, `flag`, `worktree` or `import`. */
	source: string;
	/** Where: `tui`, `print`, `json`, `rpc`, `acp`, `web`, `cli`, `worktree` or `migration`. */
	surface: string;
	decidedBy: string;
	decidedAt: number;
	/** A worktree's source checkout, or the legacy file an imported row came from. */
	fromPath?: string;
	revokedAt?: number;
	revokedBy?: string;
}

export interface FolderDecisionInput extends FolderIdentity {
	path: string;
	decision: FolderDecision;
	scope: FolderScope;
	source: string;
	surface: string;
	decidedBy: string;
	fromPath?: string;
}

const COLUMNS =
	"id, path, dev, ino, birth, decision, scope, source, surface, decided_by, decided_at, from_path, revoked_at, revoked_by";

const grant = (row: Row): FolderGrantRow => ({
	id: num(row.id),
	path: String(row.path),
	dev: String(row.dev),
	ino: String(row.ino),
	birth: String(row.birth),
	decision: row.decision === "refused" ? "refused" : "trusted",
	scope: row.scope === "subtree" ? "subtree" : "folder",
	source: String(row.source),
	surface: String(row.surface),
	decidedBy: String(row.decided_by),
	decidedAt: num(row.decided_at),
	...(typeof row.from_path === "string" ? { fromPath: row.from_path } : {}),
	...(typeof row.revoked_at === "number" ? { revokedAt: row.revoked_at } : {}),
	...(typeof row.revoked_by === "string" ? { revokedBy: row.revoked_by } : {}),
});

/** A folder as it is seen now: its identity and, for matching a row across a remount, its real path. */
type FolderLookup = Pick<FolderIdentity, "dev" | "ino"> & Partial<Pick<FolderIdentity, "birth">> & { path?: string };

/**
 * Whether `row` is the folder `seen`: `exact` when device and inode match and the birth times do not contradict;
 * `remounted` when only the device differs and the inode, a recorded birth time and the last-seen path all match.
 */
export function sameFolder(row: FolderGrantRow, seen: FolderLookup): "exact" | "remounted" | undefined {
	if (row.ino !== seen.ino) return undefined;
	const birthAgrees = row.birth === "0" || seen.birth === undefined || row.birth === seen.birth;
	if (row.dev === seen.dev) return birthAgrees ? "exact" : undefined;
	return row.birth !== "0" && row.birth === seen.birth && row.path === seen.path ? "remounted" : undefined;
}

/**
 * The live rows that may be any of `identities` (a folder and its ancestors): rows on the same device and inode, and,
 * for an identity with a birth time and path, rows on another device with that inode, birth time and path (a remount).
 * Candidates only; `sameFolder` decides which one is the folder.
 */
export function liveFoldersFor(db: DatabaseSync, identities: readonly FolderLookup[]): FolderGrantRow[] {
	if (identities.length === 0) return [];
	const params: SQLInputValue[] = [];
	const clauses: string[] = [];
	for (const { dev, ino, birth, path } of identities) {
		clauses.push("(dev = ? AND ino = ?)");
		params.push(dev, ino);
		if (birth === undefined || birth === "0" || path === undefined) continue;
		clauses.push("(ino = ? AND birth = ? AND path = ?)");
		params.push(ino, birth, path);
	}
	const where = clauses.join(" OR ");
	return allRows<Row>(
		db.prepare(`SELECT ${COLUMNS} FROM trusted_folders WHERE revoked_at IS NULL AND (${where})`),
		...params,
	).map(grant);
}

export function liveAt(db: DatabaseSync, dev: string, ino: string): FolderGrantRow | undefined {
	return liveFoldersFor(db, [{ dev, ino }])[0];
}

/**
 * Records a decision about a folder and returns its live row id. The same decision (decision and scope) on a folder that
 * already has it is a no-op that returns the existing id and `created: false` (a remounted folder's row takes the new
 * `dev`); a different one revokes the live row (`revoked_by` `superseded`) and inserts a new row. A live row whose stored
 * birth time contradicts the folder's current one no longer matches the folder (the resolver skips it), so deciding
 * again is a different decision: it supersedes the stale row and records the fresh identity. Call inside
 * `AgentDb.transaction` so two processes converge.
 */
export function decide(db: DatabaseSync, input: FolderDecisionInput, at: number): { id: number; created: boolean } {
	const rows = liveFoldersFor(db, [input]);
	// The row holding this device and inode (the unique slot), whatever its birth time, else a remounted row of the folder.
	const slot = rows.find((row) => row.dev === input.dev && row.ino === input.ino);
	const live = slot ?? rows.find((row) => sameFolder(row, input) === "remounted");
	if (live && sameFolder(live, input) && live.decision === input.decision && live.scope === input.scope) {
		if (live.dev !== input.dev) refreshSeen(db, live.id, input.path, input.dev);
		return { id: live.id, created: false };
	}
	for (const row of rows) if (row === slot || sameFolder(row, input)) revoke(db, row.id, at, "superseded");
	const result = db
		.prepare(
			`INSERT INTO trusted_folders (path, dev, ino, birth, decision, scope, source, surface, decided_by, decided_at, from_path)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.path,
			input.dev,
			input.ino,
			input.birth,
			input.decision,
			input.scope,
			input.source,
			input.surface,
			input.decidedBy,
			at,
			input.fromPath ?? null,
		);
	return { id: Number(result.lastInsertRowid), created: true };
}

/** Revokes a live row, keeping it as history. False when the row is not live (or does not exist). */
export function revoke(db: DatabaseSync, id: number, at: number, by: string): boolean {
	return (
		db
			.prepare("UPDATE trusted_folders SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL")
			.run(at, by, id).changes > 0
	);
}

/**
 * Revokes the live rows of one `source` that were last seen at `path` or that belong to the folder with this identity
 * (`identity` is absent once the folder is gone): a removed worktree's grant. Returns how many rows were revoked.
 */
export function revokeBySource(
	db: DatabaseSync,
	source: string,
	target: { path: string; identity?: Pick<FolderIdentity, "dev" | "ino"> },
	at: number,
	by: string,
): number {
	const identity = target.identity;
	return Number(
		db
			.prepare(
				`UPDATE trusted_folders SET revoked_at = ?, revoked_by = ?
				 WHERE revoked_at IS NULL AND source = ? AND (path = ? OR (dev = ? AND ino = ?))`,
			)
			.run(at, by, source, target.path, identity?.dev ?? "", identity?.ino ?? "").changes,
	);
}

/** Every row, live and revoked, newest decision first, for `/trust` and `octocode trust list`. */
export function list(db: DatabaseSync): FolderGrantRow[] {
	return allRows<Row>(db.prepare(`SELECT ${COLUMNS} FROM trusted_folders ORDER BY decided_at DESC, id DESC`)).map(
		grant,
	);
}

/** A moved, renamed or remounted folder keeps its row; the next open writes where it is now and its current device. */
export function refreshSeen(db: DatabaseSync, id: number, path: string, dev: string): void {
	db.prepare("UPDATE trusted_folders SET path = ?, dev = ? WHERE id = ? AND (path <> ? OR dev <> ?)").run(
		path,
		dev,
		id,
		path,
		dev,
	);
}
