import type { DatabaseSync } from "node:sqlite";
import { allRows } from "../rows.ts";
import { keptStatement } from "../statements.ts";

/** One provider window's latest quota reading; the same shape as `QuotaReading` in the ai package. */
export interface ProviderQuota {
	provider: string;
	window: string;
	label: string;
	/** Share of the window used, 0 to 1. */
	usedFraction: number;
	kind: "plan" | "rate";
	/** When the window resets, ms since the epoch; absent when the reading named no time. */
	resetsAt?: number;
	source: "header" | "event" | "error";
	/** When the reading was taken, ms since the epoch. */
	observedAt: number;
}

interface QuotaRow {
	provider: string;
	window: string;
	label: string;
	used: number;
	kind: ProviderQuota["kind"];
	resets_at: number | null;
	source: ProviderQuota["source"];
	updated_at: number;
}

const COLUMNS = "provider, window, label, used, kind, resets_at, source, updated_at";

const toQuota = (row: QuotaRow): ProviderQuota => ({
	provider: row.provider,
	window: row.window,
	label: row.label,
	usedFraction: row.used,
	kind: row.kind,
	...(row.resets_at === null ? {} : { resetsAt: row.resets_at }),
	source: row.source,
	observedAt: row.updated_at,
});

/**
 * Stores `quota` as its provider window's reading in one statement. A reading another process stored meanwhile that
 * was taken later is kept: processes report the same windows, and the latest observation wins.
 */
export function upsert(db: DatabaseSync, quota: ProviderQuota): void {
	keptStatement(
		db,
		`INSERT INTO provider_quota (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(provider, window) DO UPDATE SET
			label = excluded.label, used = excluded.used, kind = excluded.kind, resets_at = excluded.resets_at,
			source = excluded.source, updated_at = excluded.updated_at
		WHERE excluded.updated_at >= provider_quota.updated_at`,
	).run(
		quota.provider,
		quota.window,
		quota.label,
		quota.usedFraction,
		quota.kind,
		quota.resetsAt === undefined ? null : Math.round(quota.resetsAt),
		quota.source,
		Math.round(quota.observedAt),
	);
}

/** Every window stored for `provider`, in window order: one primary-key range. */
export function listByProvider(db: DatabaseSync, provider: string): ProviderQuota[] {
	return allRows<QuotaRow>(
		keptStatement(db, `SELECT ${COLUMNS} FROM provider_quota WHERE provider = ? ORDER BY window`),
		provider,
	).map(toQuota);
}

/** Every reading taken at or after `since` (ms since the epoch), by provider and window. */
export function listFresh(db: DatabaseSync, since: number): ProviderQuota[] {
	return allRows<QuotaRow>(
		keptStatement(db, `SELECT ${COLUMNS} FROM provider_quota WHERE updated_at >= ? ORDER BY provider, window`),
		Math.round(since),
	).map(toQuota);
}
