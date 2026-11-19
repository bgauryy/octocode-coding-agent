import type { DatabaseSync } from "node:sqlite";
import { allRows, num, type Row } from "../rows.ts";
import { ITEM_REVIEWS_SCHEMA } from "../schema-sql.ts";

/**
 * Review decisions about items Octocode did not ship (`item_reviews`): a hook, an MCP server or a skill, identified by
 * its kind, an identity that is stable while the item keeps its place, and a scope (`global`, or a repository key for a
 * project item). A decision applies to one content hash: whether the stored hash still matches the item is the guard's
 * comparison (`octocode/guard/`), these functions only read and write rows.
 */

export type ReviewDecision = "approved" | "denied" | "seen";

export interface ReviewKey {
	kind: string;
	identity: string;
	scope: string;
}

export interface ReviewRow extends ReviewKey {
	id: number;
	contentHash: string;
	decision: ReviewDecision;
	rating: string;
	/** The findings the user was shown, as JSON text. */
	findings: string;
	label: string;
	/** Where the item was last seen; shown to the user, never used to match. */
	path: string;
	decidedAt: number;
	/** `page`, `command`, `cli`, `web` or `scan` (a `seen` row nobody decided). */
	decidedVia: string;
	/** When the item was last found missing; cleared when it is seen again. */
	absentAt?: number;
}

export interface ReviewInput extends ReviewKey {
	contentHash: string;
	decision: ReviewDecision;
	rating: string;
	findings: string;
	label: string;
	path: string;
	decidedVia: string;
	/** The content an approval covers, as JSON text, so a later change can be shown against it. Kept only for `approved`. */
	snapshot?: string;
}

const COLUMNS =
	"id, kind, identity, scope, content_hash, decision, rating, findings, label, path, decided_at, decided_via, absent_at";

const review = (row: Row): ReviewRow => ({
	id: num(row.id),
	kind: String(row.kind),
	identity: String(row.identity),
	scope: String(row.scope),
	contentHash: String(row.content_hash),
	decision: row.decision === "approved" ? "approved" : row.decision === "denied" ? "denied" : "seen",
	rating: String(row.rating),
	findings: String(row.findings),
	label: String(row.label),
	path: String(row.path),
	decidedAt: num(row.decided_at),
	decidedVia: String(row.decided_via),
	...(typeof row.absent_at === "number" ? { absentAt: row.absent_at } : {}),
});

const ensured = new WeakSet<DatabaseSync>();

/** Creates the table in a file made before it existed. Once per connection; a no-op on a current file. */
export function ensure(db: DatabaseSync): void {
	if (ensured.has(db)) return;
	db.exec(ITEM_REVIEWS_SCHEMA);
	ensured.add(db);
}

/** Every row of the given scopes (`global` and the repository's), oldest first. */
export function list(db: DatabaseSync, scopes: readonly string[]): ReviewRow[] {
	ensure(db);
	if (scopes.length === 0) return [];
	return allRows<Row>(
		db.prepare(`SELECT ${COLUMNS} FROM item_reviews WHERE scope IN (${scopes.map(() => "?").join(", ")}) ORDER BY id`),
		...scopes,
	).map(review);
}

export function byId(db: DatabaseSync, id: number): ReviewRow | undefined {
	ensure(db);
	const row = db.prepare(`SELECT ${COLUMNS} FROM item_reviews WHERE id = ?`).get(id) as Row | undefined;
	return row ? review(row) : undefined;
}

/**
 * Records a decision, replacing the item's earlier row: one row per kind, identity and scope. A `seen` input never
 * replaces a person's decision about the same content; it does replace one about other content (the item changed).
 */
export function record(db: DatabaseSync, input: ReviewInput, at: number): void {
	ensure(db);
	db.prepare(
		`INSERT INTO item_reviews (kind, identity, scope, content_hash, decision, rating, findings, label, path, decided_at, decided_via)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(kind, identity, scope) DO UPDATE SET
		   content_hash = excluded.content_hash, decision = excluded.decision, rating = excluded.rating,
		   findings = excluded.findings, label = excluded.label, path = excluded.path,
		   decided_at = excluded.decided_at, decided_via = excluded.decided_via, absent_at = NULL
		 WHERE excluded.decision <> 'seen' OR item_reviews.decision = 'seen'
		    OR item_reviews.content_hash <> excluded.content_hash`,
	).run(
		input.kind,
		input.identity,
		input.scope,
		input.contentHash,
		input.decision,
		input.rating,
		input.findings,
		input.label,
		input.path,
		at,
		input.decidedVia,
	);
	if (input.decision === "approved" && input.snapshot !== undefined)
		db.prepare(
			`INSERT INTO item_review_snapshots (kind, identity, scope, files) VALUES (?, ?, ?, ?)
			 ON CONFLICT(kind, identity, scope) DO UPDATE SET files = excluded.files`,
		).run(input.kind, input.identity, input.scope, input.snapshot);
	else if (input.decision === "denied") deleteSnapshot(db, input);
}

function deleteSnapshot(db: DatabaseSync, key: ReviewKey): void {
	db.prepare("DELETE FROM item_review_snapshots WHERE kind = ? AND identity = ? AND scope = ?").run(
		key.kind,
		key.identity,
		key.scope,
	);
}

/** The approved content stored for each item of `scopes`, by kind, identity and scope; JSON text as `record` got it. */
export function snapshots(db: DatabaseSync, scopes: readonly string[]): Map<string, string> {
	ensure(db);
	const found = new Map<string, string>();
	if (scopes.length === 0) return found;
	const rows = allRows<Row>(
		db.prepare(
			`SELECT kind, identity, scope, files FROM item_review_snapshots WHERE scope IN (${scopes.map(() => "?").join(", ")})`,
		),
		...scopes,
	);
	for (const row of rows)
		found.set(JSON.stringify([String(row.kind), String(row.identity), String(row.scope)]), String(row.files));
	return found;
}

/** Deletes one decision; the item is reviewed as new at the next load. False when there was none. */
export function forget(db: DatabaseSync, id: number): boolean {
	ensure(db);
	const row = db.prepare("SELECT kind, identity, scope FROM item_reviews WHERE id = ?").get(id) as Row | undefined;
	if (row) deleteSnapshot(db, { kind: String(row.kind), identity: String(row.identity), scope: String(row.scope) });
	return db.prepare("DELETE FROM item_reviews WHERE id = ?").run(id).changes > 0;
}

/** Marks which rows of `scopes` were found this pass: the rest are stamped absent, the found ones cleared. */
export function markPresent(
	db: DatabaseSync,
	scopes: readonly string[],
	presentIds: readonly number[],
	at: number,
): void {
	ensure(db);
	if (scopes.length === 0) return;
	const inScopes = `scope IN (${scopes.map(() => "?").join(", ")})`;
	const present = presentIds.length ? `id IN (${presentIds.map(() => "?").join(", ")})` : "0";
	db.prepare(`UPDATE item_reviews SET absent_at = NULL WHERE ${inScopes} AND absent_at IS NOT NULL AND ${present}`).run(
		...scopes,
		...presentIds,
	);
	db.prepare(`UPDATE item_reviews SET absent_at = ? WHERE ${inScopes} AND absent_at IS NULL AND NOT (${present})`).run(
		at,
		...scopes,
		...presentIds,
	);
}
