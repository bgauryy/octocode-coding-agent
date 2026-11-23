/**
 * When a usage limit resets, read from the failure that reported it. A usage limit (a plan window, a quota or a spend
 * cap) lasts hours to a month, so the recovery that follows it (wait, switch or stop) needs the time, not just the fact.
 */

import { epochMs } from "../usage/quota-reading.ts";
import { normalizeProviderError } from "./error-body.ts";
import { retryAfterMsFromError } from "./provider-retry.ts";

/** A usage limit whose reset time is known when `resetsAt` is set (ms since the epoch). */
export class UsageLimitError extends Error {
	readonly resetsAt: number | undefined;
	/** The provider's name for the window that ran out (`five_hour`), when it named one. */
	readonly window: string | undefined;

	constructor(message: string, options: { resetsAt?: number; window?: string; cause?: unknown } = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "UsageLimitError";
		this.resetsAt = options.resetsAt;
		this.window = options.window;
	}
}

/** `"resets_at": 1767225600` (seconds or ms) or an ISO time; Codex `usage_limit_reached` bodies carry it. */
const RESET_AT_FIELD = /"(?:resets_at|reset_at|resetsAt|resetAt)"\s*:\s*(?:"([^"]+)"|(\d+(?:\.\d+)?))/;
/** `"resets_in_seconds": 3600` and its spellings. */
const RESET_IN_FIELD = /"(?:resets?_in_seconds|resets?_after_seconds)"\s*:\s*"?(\d+(?:\.\d+)?)/;
/** Anthropic's spend cap: "You will regain access on 2026-09-01 at 00:00 UTC." (platform.claude.com/docs/en/api/rate-limits). */
const REGAIN_ACCESS = /regain access on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2}) UTC/i;

const DURATION_UNITS: readonly (readonly [RegExp, number])[] = [
	[/^d(?:ays?)?$/, 86_400_000],
	[/^h(?:ours?|rs?)?$/, 3_600_000],
	[/^ms$/, 1],
	[/^m(?:in(?:ute)?s?)?$/, 60_000],
	[/^s(?:ec(?:ond)?s?)?$/, 1_000],
];
const DURATION_PART = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|ms|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;
/** "try again in 2h13m", "try again in 6m0s", "try again in 3 hours 20 minutes". */
const TRY_AGAIN_IN =
	/try again in\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|ms|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])[\s,]*(?:and\s+)?)+)/i;

/** The reset a JSON error body or a provider's wording names in `text`; undefined when it names none. */
function resetInBody(text: string, now: number): number | undefined {
	const at = RESET_AT_FIELD.exec(text);
	if (at) {
		const value = at[2] !== undefined ? Number(at[2]) : Number(at[1]);
		const resetsAt = Number.isFinite(value) ? epochMs(value) : Date.parse(at[1]);
		if (resetsAt !== undefined && !Number.isNaN(resetsAt)) return resetsAt;
	}
	const inSeconds = RESET_IN_FIELD.exec(text);
	if (inSeconds) return now + Number(inSeconds[1]) * 1_000;
	const regain = REGAIN_ACCESS.exec(text);
	if (regain) {
		const resetsAt = Date.parse(`${regain[1]}T${regain[2]}:00Z`);
		if (!Number.isNaN(resetsAt)) return resetsAt;
	}
	return undefined;
}

/** The wait a message states in words ("try again in 2h13m"), as a time; undefined when it states none. */
function resetInWords(text: string, now: number): number | undefined {
	const phrase = TRY_AGAIN_IN.exec(text)?.[1];
	if (!phrase) return undefined;
	let total = 0;
	for (const [, amount, unit] of phrase.matchAll(DURATION_PART)) {
		const ms = DURATION_UNITS.find(([pattern]) => pattern.test(unit.toLowerCase()))?.[1];
		if (ms !== undefined) total += Number(amount) * ms;
	}
	return total > 0 ? now + total : undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The texts an error or failed assistant message carries: its message and, when the SDK kept it apart, its body. */
function textsOf(value: Record<string, unknown>): string[] {
	const texts: string[] = [];
	if (typeof value.errorMessage === "string") texts.push(value.errorMessage);
	if (value instanceof Error) {
		const normalized = normalizeProviderError(value);
		texts.push(normalized.message);
		if (normalized.body !== undefined) texts.push(normalized.body);
	}
	return texts;
}

/**
 * When the usage limit `source` reports resets, in ms since the epoch; undefined when it names no time. `source` is
 * provider error text, an error (its cause chain is followed), or a failed assistant message (`errorMessage`,
 * `retryAfterMs`). In order: a `resetsAt` the failure carries ({@link UsageLimitError}), a reset field or date in the
 * error body (`resets_at`, `resets_in_seconds`, Anthropic's "regain access on"), the provider's `retry-after`, then
 * a wait stated in words ("try again in 2h13m").
 */
export function usageLimitResetAt(source: unknown, now: number = Date.now()): number | undefined {
	if (typeof source === "string") return resetInBody(source, now) ?? resetInWords(source, now);
	let current: unknown = source;
	for (let depth = 0; depth < 4 && isObject(current); depth++, current = current.cause) {
		if (typeof current.resetsAt === "number") {
			const resetsAt = epochMs(current.resetsAt);
			if (resetsAt !== undefined) return resetsAt;
		}
		const texts = textsOf(current);
		for (const text of texts) {
			const resetsAt = resetInBody(text, now);
			if (resetsAt !== undefined) return resetsAt;
		}
		const retryAfterMs =
			retryAfterMsFromError(current) ??
			(typeof current.retryAfterMs === "number" && current.retryAfterMs > 0 ? current.retryAfterMs : undefined);
		if (retryAfterMs !== undefined) return now + retryAfterMs;
		for (const text of texts) {
			const resetsAt = resetInWords(text, now);
			if (resetsAt !== undefined) return resetsAt;
		}
	}
	return undefined;
}
