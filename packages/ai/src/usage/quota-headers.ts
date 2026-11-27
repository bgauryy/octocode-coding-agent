/**
 * Quota readings from a response's headers. Each family is read only when its headers are present, so a provider
 * gets readings from whichever family it sends and none from the rest; a renamed header yields no reading, never a
 * wrong one. Header names are lower-case, as `Headers` iteration gives them (`headersToRecord`).
 *
 * Sources (checked 2026-11-23):
 * - Anthropic: https://platform.claude.com/docs/en/api/rate-limits ("Response headers"); resets are RFC 3339 times.
 * - OpenAI: https://developers.openai.com/api/docs/guides/rate-limits; resets are durations such as `1s` or `6m0s`.
 * - ChatGPT plan (`x-codex-*`): undocumented; names as oh-my-pi reads them (`usage/openai-codex.ts`), not checked live.
 */

import { clampUsedFraction, epochMs, type QuotaReading, quotaWindowLabel } from "./quota-reading.ts";

type Headers = Record<string, string>;

/** A header's number, or undefined when it is absent, empty or not a finite number. */
function headerNumber(headers: Headers, name: string): number | undefined {
	const raw = headers[name]?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

const DURATION_UNIT_MS: Record<string, number> = {
	h: 3_600_000,
	m: 60_000,
	s: 1_000,
	ms: 1,
	us: 1e-3,
	µs: 1e-3,
	ns: 1e-6,
};
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/gy;

/** A Go-style duration (`6m0s`, `1h2m3.5s`, `20ms`) or bare seconds, in milliseconds; undefined when it is neither. */
function durationMs(text: string | undefined): number | undefined {
	const raw = text?.trim();
	if (!raw) return undefined;
	if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) * 1_000;
	DURATION_PART.lastIndex = 0;
	let total = 0;
	let end = 0;
	for (let part = DURATION_PART.exec(raw); part; part = DURATION_PART.exec(raw)) {
		total += Number(part[1]) * DURATION_UNIT_MS[part[2]];
		end = DURATION_PART.lastIndex;
	}
	return end === raw.length ? total : undefined;
}

/** ChatGPT plan windows: `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}`. */
function codexReadings(provider: string, headers: Headers, now: number): QuotaReading[] {
	const readings: QuotaReading[] = [];
	for (const window of ["primary", "secondary"]) {
		const usedPercent = headerNumber(headers, `x-codex-${window}-used-percent`);
		if (usedPercent === undefined) continue;
		const minutes = headerNumber(headers, `x-codex-${window}-window-minutes`);
		const resetAt = headerNumber(headers, `x-codex-${window}-reset-at`);
		const resetsAt = resetAt === undefined ? undefined : epochMs(resetAt);
		readings.push({
			provider,
			window,
			label: minutes !== undefined && minutes > 0 ? quotaWindowLabel(minutes) : window,
			usedFraction: clampUsedFraction(usedPercent / 100),
			...(resetsAt !== undefined ? { resetsAt } : {}),
			kind: "plan",
			source: "header",
			observedAt: now,
		});
	}
	return readings;
}

/**
 * One rate-limit family: for each limit id, `limit` and `remaining` give the used fraction and `reset` (read by
 * `resetAt`) the time it refills.
 */
function rateReadings(
	provider: string,
	headers: Headers,
	now: number,
	limits: readonly (readonly [id: string, label: string])[],
	names: (id: string) => { limit: string; remaining: string; reset: string },
	resetAt: (value: string | undefined, now: number) => number | undefined,
): QuotaReading[] {
	const readings: QuotaReading[] = [];
	for (const [window, label] of limits) {
		const name = names(window);
		const limit = headerNumber(headers, name.limit);
		const remaining = headerNumber(headers, name.remaining);
		if (limit === undefined || remaining === undefined || limit <= 0) continue;
		const resetsAt = resetAt(headers[name.reset], now);
		readings.push({
			provider,
			window,
			label,
			usedFraction: clampUsedFraction(1 - remaining / limit),
			...(resetsAt !== undefined ? { resetsAt } : {}),
			kind: "rate",
			source: "header",
			observedAt: now,
		});
	}
	return readings;
}

const ANTHROPIC_LIMITS = [
	["requests", "requests"],
	["tokens", "tokens"],
	["input-tokens", "input tokens"],
	["output-tokens", "output tokens"],
] as const;

const OPENAI_LIMITS = [
	["requests", "requests"],
	["tokens", "tokens"],
	["project-tokens", "project tokens"],
] as const;

const rfc3339 = (value: string | undefined): number | undefined => {
	const at = value ? Date.parse(value) : Number.NaN;
	return Number.isNaN(at) ? undefined : at;
};

const afterDuration = (value: string | undefined, now: number): number | undefined => {
	const ms = durationMs(value);
	return ms === undefined ? undefined : now + ms;
};

/**
 * The quota readings a response of `provider` carries in `headers`: ChatGPT plan windows (kind `plan`), Anthropic
 * `anthropic-ratelimit-*` and OpenAI-style `x-ratelimit-*` limits (kind `rate`). Empty when it carries none.
 */
export function parseQuotaHeaders(provider: string, headers: Headers, now: number = Date.now()): QuotaReading[] {
	return [
		...codexReadings(provider, headers, now),
		...rateReadings(
			provider,
			headers,
			now,
			ANTHROPIC_LIMITS,
			(id) => ({
				limit: `anthropic-ratelimit-${id}-limit`,
				remaining: `anthropic-ratelimit-${id}-remaining`,
				reset: `anthropic-ratelimit-${id}-reset`,
			}),
			rfc3339,
		),
		...rateReadings(
			provider,
			headers,
			now,
			OPENAI_LIMITS,
			(id) => ({
				limit: `x-ratelimit-limit-${id}`,
				remaining: `x-ratelimit-remaining-${id}`,
				reset: `x-ratelimit-reset-${id}`,
			}),
			afterDuration,
		),
	];
}
