import type { DatabaseSync } from "node:sqlite";
import { read as readValue, write as writeValue } from "./meta.ts";

/**
 * Tool usage per workspace, scope (an agent profile, or `main`) and local day, and the day's frozen tier snapshot, for
 * MCP contract tiers. Both live in the `meta` table as JSON under prefixed keys, so the schema version is unchanged and
 * older databases need no migration. A day's usage is `{"sessions": n, "tools": {name: sessions}}`: how many
 * sessions made a tool call, and how many of them called each tool. Callers wrap read-modify-write in a transaction.
 */

export interface DayUsage {
	sessions: number;
	tools: Record<string, number>;
}

const usageKey = (workspace: string, scope: string, day: string) => `capability_usage:${workspace}:${scope}:${day}`;
const snapshotKey = (workspace: string, scope: string, day: string) =>
	`capability_snapshot:${workspace}:${scope}:${day}`;

const parse = <T>(text: string | undefined): T | undefined => {
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
};

/**
 * Count one session's first calls: `session` true adds the session to the day's total, and each tool in `tools` adds
 * one session to that tool. Call it inside a transaction.
 */
export function addUsage(
	db: DatabaseSync,
	workspace: string,
	scope: string,
	day: string,
	change: { session: boolean; tools: readonly string[] },
): void {
	const key = usageKey(workspace, scope, day);
	const usage = parse<DayUsage>(readValue(db, key)) ?? { sessions: 0, tools: {} };
	if (change.session) usage.sessions += 1;
	for (const tool of change.tools) usage.tools[tool] = (usage.tools[tool] ?? 0) + 1;
	writeValue(db, key, JSON.stringify(usage));
}

/** The usage of each day in `[from, to]` (ISO dates, inclusive), by day. */
export function usageBetween(
	db: DatabaseSync,
	workspace: string,
	scope: string,
	from: string,
	to: string,
): Map<string, DayUsage> {
	const prefix = `capability_usage:${workspace}:${scope}:`;
	const rows = db
		.prepare("SELECT key, value FROM meta WHERE key >= ? AND key <= ?")
		.all(`${prefix}${from}`, `${prefix}${to}`) as Array<{ key: string; value: string }>;
	const days = new Map<string, DayUsage>();
	for (const row of rows) {
		const usage = parse<DayUsage>(row.value);
		if (usage) days.set(row.key.slice(prefix.length), usage);
	}
	return days;
}

/** The stored snapshot of a day, as the JSON value it was written with. */
export function readSnapshot(db: DatabaseSync, workspace: string, scope: string, day: string): string | undefined {
	return readValue(db, snapshotKey(workspace, scope, day));
}

/** The newest snapshot before `day`, with its day, for hysteresis. */
export function previousSnapshot(
	db: DatabaseSync,
	workspace: string,
	scope: string,
	day: string,
): { day: string; value: string } | undefined {
	const prefix = `capability_snapshot:${workspace}:${scope}:`;
	const row = db
		.prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key DESC LIMIT 1")
		.get(prefix, `${prefix}${day}`) as { key: string; value: string } | undefined;
	return row ? { day: row.key.slice(prefix.length), value: row.value } : undefined;
}

export function writeSnapshot(db: DatabaseSync, workspace: string, scope: string, day: string, value: string): void {
	writeValue(db, snapshotKey(workspace, scope, day), value);
}

/** Drop usage and snapshots of days before `day` in every workspace and scope; returns how many were dropped. */
export function pruneBefore(db: DatabaseSync, day: string): number {
	let dropped = 0;
	for (const prefix of ["capability_usage:", "capability_snapshot:"]) {
		const rows = db.prepare("SELECT key FROM meta WHERE key >= ? AND key < ?").all(prefix, `${prefix}\uffff`) as Array<{
			key: string;
		}>;
		const stale = rows.filter((row) => row.key.slice(row.key.lastIndexOf(":") + 1) < day);
		for (const row of stale) db.prepare("DELETE FROM meta WHERE key = ?").run(row.key);
		dropped += stale.length;
	}
	return dropped;
}
