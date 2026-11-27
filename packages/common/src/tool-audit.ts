/**
 * Per-tool audit rows from the usage record (`usage-counts.ts`): who used a tool and who did not, in the role group
 * that is asking. Pure over the counts, so the terminal, the `mcp` tool and the web page show the same numbers.
 */

import type { ToolAudit } from "@octocodeai/octocode-contracts/config";
import { usageCounts, usageLastUsed, type UsageByTool, type UsageGroup } from "./usage-counts.ts";

/** The record of one group, read once: the summed counts and each tool's last day of use. */
export interface UsageAuditSource {
	counts: UsageByTool;
	lastUsed: ReadonlyMap<string, string>;
}

/** Reads the kept days of `group`. Empty when the file is missing or unreadable. */
export function readUsageAudit(file: string, group: UsageGroup, now: number = Date.now()): UsageAuditSource {
	return { counts: usageCounts(file, group, now), lastUsed: usageLastUsed(file, group, now) };
}

/** Whether the record holds any count, so a view can tell "no data yet" from "unused". */
export const hasUsageData = (source: UsageAuditSource): boolean => Object.keys(source.counts).length > 0;

/**
 * One tool's audit. `key` is `<server>/<tool>` or `native/<tool>`; `state` is what the session declares; `promoted`
 * tells whether the session's snapshot holds the tool (only under `mcpExposure: "usage"`, else undefined: no reason is
 * given), and `onDemand` whether the configuration leaves it on demand, the only tools the snapshot changes: such a
 * tool in the snapshot is declared thin from the session's start instead of waiting for its first use (`promoted`).
 * `saved` is full minus thin declaration bytes, reported only while the tool is deferred.
 */
export function toolAudit(
	source: UsageAuditSource,
	key: string,
	state: "direct" | "deferred" | "onDemand" | "hidden",
	options: { promoted?: boolean; onDemand?: boolean; saved?: number } = {},
): ToolAudit {
	const counts = source.counts[key] ?? { declared: 0, called: 0, loaded: 0, calledUndeclared: 0, refused: 0, used: 0 };
	const lastUsed = source.lastUsed.get(key);
	const reason =
		options.promoted === undefined
			? undefined
			: options.promoted && options.onDemand === true && state !== "hidden"
				? ("promoted" as const)
				: state === "deferred" && lastUsed === undefined
					? ("unused" as const)
					: undefined;
	const bytesSaved = state === "deferred" ? Math.max(0, Math.round(options.saved ?? 0)) : 0;
	return {
		declared: counts.declared,
		called: counts.called,
		used: counts.used,
		refused: counts.refused,
		rate: counts.declared > 0 ? Math.min(1, counts.used / counts.declared) : 0,
		...(lastUsed ? { lastUsed } : {}),
		...(options.saved !== undefined ? { bytesSaved } : {}),
		...(reason ? { reason } : {}),
	};
}

/** Tools unused in the kept days first, then the lowest rate. */
export const compareAudit = (a: ToolAudit, b: ToolAudit): number =>
	Number(a.lastUsed !== undefined) - Number(b.lastUsed !== undefined) || a.rate - b.rate;

/** Rows with an audit in audit order (stable), then the rows without one in their order. */
export function sortByAudit<T extends { audit?: ToolAudit }>(rows: readonly T[]): T[] {
	const audited = rows.filter((row) => row.audit !== undefined);
	const rest = rows.filter((row) => row.audit === undefined);
	return [...audited.sort((a, b) => compareAudit(a.audit!, b.audit!)), ...rest];
}

const size = (bytes: number): string => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`);

/** One short line for a listing: `1.9% of 52 sessions · 3 calls · last 2026-11-12 · 1 refused · saves 8.5 KB`. */
export function formatAudit(audit: ToolAudit): string {
	return [
		`${(audit.rate * 100).toFixed(1)}% of ${audit.declared} sessions`,
		`${audit.called} calls`,
		audit.lastUsed ? `last ${audit.lastUsed}` : "unused in 7 days",
		...(audit.refused > 0 ? [`${audit.refused} refused`] : []),
		...(audit.bytesSaved ? [`saves ${size(audit.bytesSaved)}`] : []),
	].join(" · ");
}
