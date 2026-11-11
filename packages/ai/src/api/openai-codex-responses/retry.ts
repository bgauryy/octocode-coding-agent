import { isTerminalProviderLimitError } from "../../utils/retry.ts";

// Retry delays (`Retry-After` parsing, the delay limit and its error) come from utils/retry.ts, shared with every provider.

export function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 && isTerminalProviderLimitError(errorText)) {
		return false;
	}
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

/**
 * A final HTTP error from the Codex SSE endpoint, with its status (a 413 still reads as context overflow) and
 * headers (a `Retry-After` reaches the error message as `retryAfterMs`).
 */
export class CodexHttpError extends Error {
	readonly status: number;
	readonly headers: Headers;
	constructor(message: string, status: number, headers: Headers) {
		super(message);
		this.name = "CodexHttpError";
		this.status = status;
		this.headers = headers;
	}
}

export function normalizeTimeoutMs(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid timeoutMs: ${String(value)}`);
	}
	return Math.floor(value);
}
