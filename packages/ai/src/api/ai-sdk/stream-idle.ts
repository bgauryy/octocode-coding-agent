import { APICallError } from "@ai-sdk/provider";

/**
 * Longest wait for the next chunk of a provider response body. Any bytes count, so SSE comments and keep-alive
 * pings reset it; only a stream that goes completely silent trips it. Matches the coding agent's HTTP idle default:
 * reasoning models can think for minutes before the first token, so a shorter limit would cut valid turns.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** Resolves the effective idle limit; `0` disables it. */
export function resolveStreamIdleTimeoutMs(value: number | undefined): number | undefined {
	if (value === undefined) return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid streamIdleTimeoutMs: ${String(value)}`);
	return value === 0 ? undefined : value;
}

/** Retryable by the session retry policy: the message contains "timed out". */
export function streamIdleError(timeoutMs: number, url: string): APICallError {
	return new APICallError({
		message: `Model stream idle: no data received for ${timeoutMs}ms (timed out)`,
		url,
		requestBodyValues: undefined,
		isRetryable: true,
	});
}

/** Reads the next chunk, rejecting with `onIdle()` when none arrives within `timeoutMs`. The timer never outlives the read. */
export async function readWithIdleTimeout<T>(
	read: Promise<T>,
	timeoutMs: number | undefined,
	onIdle: () => Error,
): Promise<T> {
	if (timeoutMs === undefined) return read;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const idle = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(onIdle()), timeoutMs);
		timer.unref();
	});
	try {
		return await Promise.race([read, idle]);
	} finally {
		clearTimeout(timer);
	}
}
