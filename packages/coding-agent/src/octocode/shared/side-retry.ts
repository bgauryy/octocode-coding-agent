import { type AssistantMessage, retryAssistantCall } from "@octocodeai/octocode-ai";

/**
 * The retry of a side call: a model request outside the session turn, which the session's own retry never sees. The
 * shared classifier decides what is retried (a rate limit or a transient failure, never a usage limit or a refused
 * request) and how long each wait is (the provider's `retry-after` when it gives one); this budget only bounds it:
 * at most `retries` retries, and none whose wait would take the waits past `maxWaitMs` in all.
 */
export interface SideRetry {
	retries: number;
	maxWaitMs: number;
}

/** A call the user waits on (prompt optimization, prompt hooks): a few seconds of waiting at most. */
export const INTERACTIVE_RETRY: SideRetry = { retries: 2, maxWaitMs: 5_000 };
/** A background pass (memory): nobody waits on it, so it waits longer; its caller's deadline still ends it. */
export const BACKGROUND_RETRY: SideRetry = { retries: 3, maxWaitMs: 12_000 };

/** First wait of the exponential backoff: 1 s, 2 s, 4 s, a rate limit's or capacity failure's spread by up to half again. */
const BASE_DELAY_MS = 1_000;

/**
 * `produce` once, then retried within `retry` (no retry when it is undefined or allows none). Returns the last reply: a
 * success, a failure (also when the budget or `signal` ends the wait after it, so the cause stays known), or an aborted
 * reply when `signal` ended a request. `produce` owns its request's signal; `signal` is the caller's.
 */
export async function retrySideCall(
	produce: () => Promise<AssistantMessage>,
	retry: SideRetry | undefined,
	signal: AbortSignal,
): Promise<AssistantMessage> {
	if (!retry || retry.retries <= 0) return produce();
	let last: AssistantMessage | undefined;
	let retries = 0;
	let waitedMs = 0;
	// Aborted before a wait the budget cannot pay for: the retry loop then returns at once.
	const spent = new AbortController();
	const reply = await retryAssistantCall(
		async () => (last = await produce()),
		{
			enabled: true,
			maxRetries: retry.retries,
			baseDelayMs: BASE_DELAY_MS,
			// Left at the library default: the budget below ends a wait past `maxWaitMs` itself and returns the provider's
			// own error, where the library would append a note naming `retry.maxAgentDelayMs`, a setting side calls ignore.
			offlineIntervalMs: 2 * BASE_DELAY_MS,
			offlineMaxMs: retry.maxWaitMs,
		},
		AbortSignal.any([signal, spent.signal]),
		{
			onRetryScheduled: (_attempt, _maxAttempts, delayMs) => {
				// A provider asking for more than is left is not retried early: that attempt would fail the same way.
				const waitMs = Math.max(delayMs, last?.retryAfterMs ?? 0);
				if (retries >= retry.retries || waitedMs + waitMs > retry.maxWaitMs) {
					spent.abort();
					return;
				}
				retries++;
				waitedMs += waitMs;
			},
		},
	);
	return reply.stopReason === "aborted" && last?.stopReason === "error" ? last : reply;
}
