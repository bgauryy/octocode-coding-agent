import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * A prepared statement kept per connection, for queries that run on every tool call (a lease check, the relay inbox):
 * compiling the SQL again each time cost more than running it. Each connection keeps its own statements and drops them
 * with it; SQLite recompiles a kept statement by itself when the schema changes. Only for statements run whole (`get`,
 * `all`, `run`), never `iterate`, so one use cannot overlap another.
 */
const kept = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
/** Statements kept per connection; the oldest is dropped past this (a query whose SQL varies keeps a few). */
const KEPT = 64;

export function keptStatement(db: DatabaseSync, sql: string): StatementSync {
	let statements = kept.get(db);
	if (!statements) kept.set(db, (statements = new Map()));
	const known = statements.get(sql);
	if (known) return known;
	const statement = db.prepare(sql);
	statements.set(sql, statement);
	if (statements.size > KEPT) statements.delete(statements.keys().next().value!);
	return statement;
}
