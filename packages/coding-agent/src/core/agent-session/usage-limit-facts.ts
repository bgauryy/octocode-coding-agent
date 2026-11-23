/**
 * The facts of a usage limit that ended a turn: when it resets, how a person reads that time, and the session entry a
 * parent reads from its child. A usage limit (a plan window, a quota or a spend cap) lasts hours to a month, so what
 * follows it (wait, switch or stop, `usage-limit-recovery.ts`) needs the time, not just the fact.
 */

import { type QuotaReading, usageLimitResetAt } from "@octocodeai/octocode-ai";
import type { AssistantMessage } from "@octocodeai/octocode-ai/compat";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { resetClock } from "@octocodeai/octocode-common/time";

/** After the reset the provider may still refuse for a moment (clock skew, its own rounding): resume this much later. */
export const USAGE_RESUME_GRACE_MS = 30_000;

/** The custom session entry a turn that ended on a usage limit appends unattended; a child sends it as `entry_appended`. */
export const USAGE_LIMIT_ENTRY = "octocode-usage-limit";

/** What a parent learns about its child's usage limit. Machine fields: change them only with their readers. */
export interface UsageLimitRecord {
	/** The provider whose limit ran out. */
	provider: string;
	/** `provider/id` of the model that failed. */
	model: string;
	/** When the limit resets, ms since the epoch; absent when neither the failure nor a quota reading named a time. */
	resetsAt?: number;
}

/** The record a child's `entry_appended` event carries (its `USAGE_LIMIT_ENTRY`); undefined for any other entry. */
export function usageLimitRecord(entry: unknown): UsageLimitRecord | undefined {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== USAGE_LIMIT_ENTRY || !isRecord(entry.data))
		return undefined;
	const { provider, model, resetsAt } = entry.data;
	if (typeof provider !== "string" || typeof model !== "string") return undefined;
	return { provider, model, ...(typeof resetsAt === "number" && Number.isFinite(resetsAt) ? { resetsAt } : {}) };
}

/**
 * When the usage limit of `message` resets: the time the failure names (`usageLimitResetAt`: a reset field, the body's
 * date, `retry-after`, "try again in"), else the latest reset among the provider's spent plan windows (`readings`, the
 * quota store's), which tells the window that ran out even when the error text names no time. Undefined when neither
 * does, or the time is already past.
 */
export function usageLimitResetsAt(
	message: AssistantMessage,
	readings: readonly QuotaReading[],
	now: number = Date.now(),
): number | undefined {
	const named = usageLimitResetAt(message, now);
	if (named !== undefined && named > now) return named;
	let latest: number | undefined;
	for (const reading of readings)
		if (
			reading.kind === "plan" &&
			reading.usedFraction >= 1 &&
			reading.resetsAt !== undefined &&
			reading.resetsAt > now
		)
			latest = Math.max(latest ?? 0, reading.resetsAt);
	return latest;
}

/** A wait in its two largest units: `2h 10m`, `45m`, `3d 4h`, `40s`. */
export function waitSpan(ms: number): string {
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
	const minutes = Math.round(ms / 60_000);
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const rest = minutes % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
	return `${rest}m`;
}

/** `resets 14:20 (in 2h 10m)`, or `reset time unknown`. */
export function resetText(resetsAt: number | undefined, now: number): string {
	return resetsAt === undefined
		? "reset time unknown"
		: `resets ${resetClock(resetsAt, now)} (in ${waitSpan(resetsAt - now)})`;
}
