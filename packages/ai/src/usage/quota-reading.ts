/**
 * A quota reading: how much of one provider window is used and when it resets, as a response, a CLI event or an
 * error reported it. Readings are passive: they come only from traffic Octocode already sends, never from polling.
 */

/** `plan`: a subscription allowance that resets after hours or days. `rate`: an API rate limit that refills within a minute. */
export type QuotaKind = "plan" | "rate";

/** What reported the reading: response headers, a CLI's stream event, or an error. */
export type QuotaSource = "header" | "event" | "error";

export interface QuotaReading {
	provider: string;
	/** Stable id of the window within its provider (`primary`, `five_hour`, `requests`); one reading per provider and window. */
	window: string;
	/** The window as a person reads it: `5h`, `week`, `requests`. */
	label: string;
	/** Share of the window used, 0 to 1. */
	usedFraction: number;
	/** When the window resets or refills, ms since the epoch; absent when the source named no time. */
	resetsAt?: number;
	kind: QuotaKind;
	source: QuotaSource;
	/** When the reading was taken, ms since the epoch. */
	observedAt: number;
}

/** `value` clamped to the 0–1 range a used fraction takes; a value past 1 (usage run past the cap) reads as 1. */
export function clampUsedFraction(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/**
 * An epoch time given in seconds or milliseconds, as milliseconds. Values below 10^12 are seconds (10^12 ms is
 * September 2001, so no current time in ms is that small). Undefined unless positive and finite.
 */
export function epochMs(value: number): number | undefined {
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return value < 1e12 ? value * 1000 : value;
}

const MINUTES_PER_DAY = 1_440;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** A window's length as its label: `week`, `30d`, `5h`, `90m`. */
export function quotaWindowLabel(minutes: number): string {
	if (minutes === MINUTES_PER_WEEK) return "week";
	if (minutes >= MINUTES_PER_DAY && minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}d`;
	if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
	return `${Math.round(minutes)}m`;
}
