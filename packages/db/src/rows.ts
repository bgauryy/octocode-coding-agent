import type { SQLInputValue, StatementSync } from "node:sqlite";

/** One SQLite result row as `node:sqlite` returns it. */
export type Row = Record<string, unknown>;

/** A numeric column, or 0 when it is NULL or not a number. */
export const num = (value: unknown): number => (typeof value === "number" ? value : 0);

/**
 * Runs `statement` and types its rows as `T`. `node:sqlite` types every row as a bag of column values; the caller names
 * the shape its own SELECT produces, next to the statement, so this is the one place that trusts it.
 */
export function allRows<T>(statement: StatementSync, ...params: SQLInputValue[]): T[] {
	return statement.all(...params) as unknown as T[];
}
