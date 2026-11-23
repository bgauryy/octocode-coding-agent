import type { DatabaseSync } from "node:sqlite";
import { allRows } from "../rows.ts";
import { keptStatement } from "../statements.ts";

/** Who paid: `plan`, a subscription (its `cost` is an estimate at list price), or `metered` (its `cost` is money). */
export type UsageBilling = "plan" | "metered";

/** The figures a day's row adds up; `unpriced` counts requests to a model without pricing (their tokens cost $0 here). */
interface UsageFigures {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	unpriced: number;
}

/** One request's or one batch's spend, under its key: `day` is the local `YYYY-MM-DD` it was recorded on. */
export interface UsageDailyRow extends UsageFigures {
	day: string;
	workspaceId: string;
	provider: string;
	model: string;
	kind: string;
	billing: UsageBilling;
}

/** A range's spend on one model under one billing, every workspace and kind added. */
export interface UsageTotalRow extends UsageFigures {
	provider: string;
	model: string;
	billing: UsageBilling;
}

const ADD = `INSERT INTO usage_daily
	(day, workspace_id, provider, model, kind, billing, requests, input, output, cache_read, cache_write, cost, unpriced)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(day, workspace_id, provider, model, kind, billing) DO UPDATE SET
		requests = requests + excluded.requests, input = input + excluded.input, output = output + excluded.output,
		cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
		cost = cost + excluded.cost, unpriced = unpriced + excluded.unpriced`;

/** Adds each row to its day's row, creating it on the first request: one kept statement per row, in the caller's transaction. */
export function add(db: DatabaseSync, rows: readonly UsageDailyRow[]): void {
	const statement = keptStatement(db, ADD);
	for (const row of rows)
		statement.run(
			row.day,
			row.workspaceId,
			row.provider,
			row.model,
			row.kind,
			row.billing,
			row.requests,
			row.input,
			row.output,
			row.cacheRead,
			row.cacheWrite,
			row.cost,
			row.unpriced,
		);
}

/** Spend from day `from` through day `to` (both `YYYY-MM-DD`, inclusive) by provider, model and billing, the costliest first. */
export function totals(db: DatabaseSync, from: string, to: string): UsageTotalRow[] {
	return allRows<UsageTotalRow>(
		db.prepare(`SELECT provider, model, billing, SUM(requests) AS requests, SUM(input) AS input, SUM(output) AS output,
			SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite, SUM(cost) AS cost, SUM(unpriced) AS unpriced
			FROM usage_daily WHERE day BETWEEN ? AND ?
			GROUP BY provider, model, billing ORDER BY SUM(cost) DESC, provider, model, billing`),
		from,
		to,
	);
}

/** The first day anything was recorded (`YYYY-MM-DD`), or undefined before the first request: where the history starts. */
export function firstDay(db: DatabaseSync): string | undefined {
	const row = db.prepare("SELECT MIN(day) AS day FROM usage_daily").get() as { day: string | null } | undefined;
	return row?.day ?? undefined;
}
