import type { AssistantMessage } from "../types.ts";
import { createAbortError, sleepUnlessAborted } from "./abort.ts";
import { clearsWithWaiting, isOfflineText, isRetryableAssistantError } from "./retry-classes.ts";

export {
	isOfflineText,
	isRateLimitedText,
	isRetryableAssistantError,
	isRetryableErrorText,
	isTerminalProviderLimitError,
	isUsageLimitError,
} from "./retry-classes.ts";

/** A failure that clears by waiting gets at least this many retries, because a token bucket refills meanwhile and an outage ends. */
export const RATE_LIMIT_MIN_RETRIES = 6;
/** Wall-clock time from the first failure during which a failure that clears by waiting may use retries beyond the configured ones. */
export const RATE_LIMIT_WINDOW_MS = 180_000;
/** Spread added on top of a provider-requested delay, so sessions given the same `retry-after` do not return together. */
const RETRY_AFTER_SPREAD_MS = 1000;
/** Wall-clock time from the first failure during which a no-route network failure keeps retrying: the connection may return. */
export const OFFLINE_WINDOW_MS = 600_000;
/** Longest wait between two retries of a no-route network failure, so a returning connection is noticed soon. */
export const OFFLINE_MAX_GAP_MS = 30_000;
/** Upper bound on retries of a no-route network failure; the window ends them first unless each attempt fails at once. */
const OFFLINE_MAX_RETRIES = 40;

/** Retries allowed for this failure: the configured budget, raised for a failure that clears by waiting unless retries are off. */
export function retryBudget(maxRetries: number, errorText: string): number {
	if (maxRetries > 0 && isOfflineText(errorText)) return Math.max(maxRetries, OFFLINE_MAX_RETRIES);
	if (maxRetries <= 0 || !clearsWithWaiting(errorText)) return maxRetries;
	return Math.max(maxRetries, RATE_LIMIT_MIN_RETRIES);
}

/**
 * Whether retry number `attempt` (1-indexed) may run, `elapsedMs` after the first failure. The configured attempts are
 * always allowed; the window bounds only the ones a failure that clears by waiting adds on top, and it is wall clock,
 * so time spent inside each failed request counts as much as time spent sleeping.
 */
export function mayRetry(attempt: number, maxRetries: number, errorText: string, elapsedMs: number): boolean {
	if (attempt > retryBudget(maxRetries, errorText)) return false;
	const windowMs = isOfflineText(errorText) ? OFFLINE_WINDOW_MS : RATE_LIMIT_WINDOW_MS;
	return attempt <= maxRetries || elapsedMs < windowMs;
}

/**
 * Delay before retry number `attempt`. A failure that clears by waiting waits up to half again the backoff, so parallel
 * subagents hit by one outage or quota spread their retries, and never less than the provider's `retry-after`; the
 * result is capped by `maxAgentDelayMs`, and an attempt past the configured ones is pulled into what is left of the
 * window. Any other error keeps the exact exponential backoff.
 */
export function retryDelayFor(
	policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs" | "maxRetries">,
	attempt: number,
	failure: Pick<AssistantMessage, "errorMessage" | "retryAfterMs">,
	elapsedMs: number,
	random: () => number = Math.random,
): number {
	const backoffMs = retryDelayMs(policy, attempt);
	if (isOfflineText(failure.errorMessage ?? "")) {
		// Retrying sooner than the gap costs nothing while offline: no request reaches a provider.
		const spread = Math.round(backoffMs + (backoffMs / 2) * random());
		return Math.min(spread, OFFLINE_MAX_GAP_MS, Math.max(0, OFFLINE_WINDOW_MS - elapsedMs));
	}
	if (!clearsWithWaiting(failure.errorMessage ?? "")) return backoffMs;
	const cap =
		policy.maxAgentDelayMs === undefined ? Number.POSITIVE_INFINITY : Math.max(backoffMs, policy.maxAgentDelayMs);
	const spread = Math.round(backoffMs + (backoffMs / 2) * random());
	const requested = failure.retryAfterMs;
	const asked = requested !== undefined && requested > 0 ? requested : 0;
	const providerDelay = asked > 0 ? asked + Math.round(RETRY_AFTER_SPREAD_MS * random()) : 0;
	const delayMs = Math.min(Math.max(spread, providerDelay), cap);
	if (attempt <= policy.maxRetries) return delayMs;
	// The window never pulls a retry in below what the provider asked for: an earlier retry would only fail again.
	const leftMs = Math.max(0, RATE_LIMIT_WINDOW_MS - elapsedMs);
	return Math.max(Math.min(delayMs, leftMs), Math.min(asked, cap));
}

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * `maxAgentDelayMs` caps each computed delay and defaults to 60 seconds.
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`, `maxAgentDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
	/** Optional cap for agent-level retry delays in ms. Defaults to 60 seconds. */
	maxAgentDelayMs?: number;
}

/** Longest retry delay any layer waits: the agent backoff cap and the longest `Retry-After` a provider request accepts. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

export function retryDelayMs(policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">, attempt: number): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS);
}

function parseNonNegativeNumber(value: string | null | undefined): number | undefined {
	if (value === null || value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

/**
 * The delay a provider asked for, in milliseconds, or `undefined` when the headers carry none: `retry-after-ms`, else
 * `retry-after` as decimal seconds or an HTTP date. Values are clamped to at least zero (a past date means retry now).
 * Anything else, including a suffixed value such as "5s" or an empty header, is ignored so the caller backs off on its own.
 */
export function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
	const fromMs = parseNonNegativeNumber(headers?.get("retry-after-ms"));
	if (fromMs !== undefined) return fromMs;

	const retryAfter = headers?.get("retry-after")?.trim();
	if (!retryAfter) return undefined;
	const seconds = parseNonNegativeNumber(retryAfter);
	if (seconds !== undefined) return seconds * 1000;
	const date = Date.parse(retryAfter);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * A provider asked for a retry delay above the limit; the request fails instead of waiting. It keeps the response's
 * status and headers, so the session retry above it can still read how long the provider asked it to wait.
 */
export class RetryDelayExceededError extends Error {
	readonly status: number | undefined;
	readonly headers: Headers | undefined;

	constructor(message: string, response?: { status?: number; headers?: Headers }) {
		super(message);
		this.status = response?.status;
		this.headers = response?.headers;
	}
}

/** Returns `delayMs`, or throws {@link RetryDelayExceededError} when it exceeds `maxRetryDelayMs` (default 60 s; zero or less disables the limit). */
export function validateRetryDelayMs(
	delayMs: number,
	maxRetryDelayMs?: number,
	detail?: string,
	response?: { status?: number; headers?: Headers },
): number {
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxDelayMs > 0 && delayMs > maxDelayMs) {
		const message = `Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s)`;
		throw new RetryDelayExceededError(detail ? `${message}. ${detail}` : message, response);
	}
	return delayMs;
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries by the same policy as an agent turn ({@link mayRetry}, {@link retryDelayFor}), emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxRetries = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let firstFailureAt: number | undefined;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// Non-retryable, or budget exhausted: return the final error message.
		const errorText = response.errorMessage ?? "";
		const elapsedMs = firstFailureAt === undefined ? 0 : Date.now() - firstFailureAt;
		if (!isRetryableAssistantError(response) || !mayRetry(attempt + 1, maxRetries, errorText, elapsedMs)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		firstFailureAt ??= Date.now();
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const delayMs = retryDelayFor(policy!, attempt, response, elapsedMs);
		await callbacks?.onRetryScheduled?.(attempt, retryBudget(maxRetries, errorText), delayMs, lastRetry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleepUnlessAborted(delayMs, signal, createAbortError);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof Error && error.name === "AbortError") {
				const { errorMessage: _errorMessage, ...rest } = response;
				return { ...rest, stopReason: "aborted" };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}
