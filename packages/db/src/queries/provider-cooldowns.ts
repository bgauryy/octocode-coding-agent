import type { DatabaseSync } from "node:sqlite";
import { keptStatement } from "../statements.ts";

/** A provider's rate-limit cool-down: no request to it should start before `until` (ms since the epoch). */
export interface ProviderCooldown {
	until: number;
	/** The pause this side chose for the last rate limit that named no wait of its own; 0 when none did. */
	pauseMs: number;
}

/**
 * The cool-down last recorded for `provider`, ended or not (its pause decides how the next one grows); undefined when none
 * was. Runs at the start of every model request: one primary-key probe on a kept statement.
 */
export function read(db: DatabaseSync, provider: string): ProviderCooldown | undefined {
	const row = keptStatement(db, "SELECT until_ms, pause_ms FROM provider_cooldowns WHERE provider = ?").get(
		provider,
	) as { until_ms: number; pause_ms: number } | undefined;
	return row && { until: row.until_ms, pauseMs: row.pause_ms };
}

/**
 * Records `cooldown` for `provider` in one statement. A cool-down another process recorded meanwhile that ends later is
 * kept, with its pause: siblings failing on one throttle each compute from the row they read, and the latest end wins.
 */
export function record(db: DatabaseSync, provider: string, cooldown: ProviderCooldown): void {
	db.prepare(
		`INSERT INTO provider_cooldowns (provider, until_ms, pause_ms) VALUES (?, ?, ?)
		ON CONFLICT(provider) DO UPDATE SET
			pause_ms = CASE WHEN excluded.until_ms >= provider_cooldowns.until_ms THEN excluded.pause_ms ELSE provider_cooldowns.pause_ms END,
			until_ms = MAX(provider_cooldowns.until_ms, excluded.until_ms)`,
	).run(provider, Math.round(cooldown.until), Math.round(cooldown.pauseMs));
}
