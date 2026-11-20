import type { DatabaseSync } from "node:sqlite";
import { allRows } from "../rows.ts";
import { ITEM_HANDOFFS_SCHEMA } from "../schema-handoffs.ts";

/**
 * The backlog items a coordinator handed to one of its running children (`agent` `message` with `item`), by the
 * child's agent id and the item's row id. The child's backlog writes accept them besides its start item; the
 * coordinator removes them when the child's run ends.
 */
const ensured = new WeakSet<DatabaseSync>();

/** Creates the table in a file made before it existed. Once per connection; a no-op on a current file. */
export function ensure(db: DatabaseSync): void {
	if (ensured.has(db)) return;
	db.exec(ITEM_HANDOFFS_SCHEMA);
	ensured.add(db);
}

/** Records that `by` handed item `itemId` to `agent`; a repeat keeps one row. */
export function grant(db: DatabaseSync, agent: string, itemId: number, by: string, at: number): void {
	ensure(db);
	db.prepare(
		`INSERT INTO item_handoffs (agent, item_id, by_agent, at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(agent, item_id) DO UPDATE SET by_agent = excluded.by_agent, at = excluded.at`,
	).run(agent, itemId, by, at);
}

/** Whether item `itemId` was handed to `agent`. */
export function holds(db: DatabaseSync, agent: string, itemId: number): boolean {
	ensure(db);
	return (
		db.prepare("SELECT 1 AS found FROM item_handoffs WHERE agent = ? AND item_id = ?").get(agent, itemId) !== undefined
	);
}

/** The item row ids handed to `agent`, oldest first. */
export function itemsOf(db: DatabaseSync, agent: string): number[] {
	ensure(db);
	return allRows<{ item_id: number }>(
		db.prepare("SELECT item_id FROM item_handoffs WHERE agent = ? ORDER BY at, item_id"),
		agent,
	).map((row) => row.item_id);
}

/** Removes every handoff (`purge.all`); the count removed. */
export function clear(db: DatabaseSync): number {
	ensure(db);
	return Number(db.prepare("DELETE FROM item_handoffs").run().changes);
}

/** Removes one handed item (`itemId`), or every item handed to `agent`. */
export function revoke(db: DatabaseSync, agent: string, itemId?: number): void {
	ensure(db);
	if (itemId === undefined) db.prepare("DELETE FROM item_handoffs WHERE agent = ?").run(agent);
	else db.prepare("DELETE FROM item_handoffs WHERE agent = ? AND item_id = ?").run(agent, itemId);
}
