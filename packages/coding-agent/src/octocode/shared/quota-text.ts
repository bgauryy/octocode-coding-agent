/**
 * Quota readings as people read them, shared by `/status` (`status-quota.ts`), `/usage` (`usage/report.ts`) and the
 * footer (`ui/footer/parts.ts`): one window as `5h 62% · resets 14:20`, a provider's windows on one line, and the plan
 * window the footer shows once it nears its cap.
 */

import type { QuotaReading } from "@octocodeai/octocode-ai";
import { resetClock } from "@octocodeai/octocode-common/time";

/** Where a plan window starts to show in the footer (warning colour), and where it turns red. */
const QUOTA_WARN = 0.7;
export const QUOTA_ALARM = 0.9;

/** The plan window closest to its cap, when one is at {@link QUOTA_WARN} or more; rate limits refill and never count. */
export function tightestPlanWindow(readings: readonly QuotaReading[]): QuotaReading | undefined {
	let tightest: QuotaReading | undefined;
	for (const reading of readings)
		if (reading.kind === "plan" && reading.usedFraction >= QUOTA_WARN)
			if (!tightest || reading.usedFraction > tightest.usedFraction) tightest = reading;
	return tightest;
}

/** One window: `5h 62% · resets 14:20`; a rate limit (it refills within a minute) without its reset. */
function windowText(reading: QuotaReading, now: number): string {
	const used = `${reading.label} ${Math.round(reading.usedFraction * 100)}%`;
	return reading.kind === "plan" && reading.resetsAt !== undefined
		? `${used} · resets ${resetClock(reading.resetsAt, now)}`
		: used;
}

/** A provider's readings as one text: `5h 62% · resets 14:20 · week 18% · resets Fri 09:00`. */
export const readingsText = (readings: readonly QuotaReading[], now: number): string =>
	readings.map((reading) => windowText(reading, now)).join(" · ");

/** Readings of several providers (`ProviderQuotas.all()`, grouped by provider) as one text each, in their order. */
export function quotaTexts(readings: readonly QuotaReading[], now: number): { provider: string; text: string }[] {
	const byProvider = new Map<string, QuotaReading[]>();
	for (const reading of readings)
		byProvider.set(reading.provider, [...(byProvider.get(reading.provider) ?? []), reading]);
	return [...byProvider].map(([provider, list]) => ({ provider, text: readingsText(list, now) }));
}

/** `provider  text` rows under a heading, provider names padded so every provider's windows start in one column. */
export function quotaRows(lines: readonly { provider: string; text: string }[]): string[] {
	const width = Math.max(0, ...lines.map((line) => line.provider.length));
	return lines.map((line) => `  ${line.provider.padEnd(width)}  ${line.text}`);
}
