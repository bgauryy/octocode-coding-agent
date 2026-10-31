import { APICallError } from "@ai-sdk/provider";
import { createAbortError, sleepUnlessAborted } from "./abort.ts";
import { parseRetryAfterMs, validateRetryDelayMs } from "./retry.ts";

interface ProviderRetryOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
	/** HTTP statuses that fail at once although the default policy would retry them. */
	noRetryStatuses?: readonly number[];
}

interface ProviderError {
	message: string;
	status: number | undefined;
	headers: Headers | undefined;
	isRetryable?: boolean;
}

function getProviderError(error: unknown): ProviderError | undefined {
	if (APICallError.isInstance(error)) {
		return {
			message: error.message,
			status: error.statusCode,
			headers: error.responseHeaders ? new Headers(error.responseHeaders) : undefined,
			isRetryable: error.isRetryable,
		};
	}
	if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return undefined;
	if (
		(error.status !== undefined && typeof error.status !== "number") ||
		(error.headers !== undefined && !(error.headers instanceof Headers))
	)
		return undefined;
	return { message: error.message, status: error.status, headers: error.headers };
}

/** Mirrors the pinned OpenAI/Anthropic SDK retry policy; review when either SDK is upgraded. */
function isRetryableProviderError(error: ProviderError): boolean {
	const shouldRetry = error.headers?.get("x-should-retry");
	if (shouldRetry === "true") return true;
	if (shouldRetry === "false") return false;

	if (error.status === undefined) return error.isRetryable ?? true;
	return (
		error.status === 408 ||
		error.status === 409 ||
		error.status === 429 ||
		(typeof error.status === "number" && error.status >= 500)
	);
}

/** Headers of an AWS SDK error: its raw HTTP response carries them as a plain record, not a `Headers`. */
function awsResponseHeaders(error: Error): Headers | undefined {
	const raw = (error as { $response?: { headers?: unknown } }).$response?.headers;
	if (typeof raw !== "object" || raw === null) return undefined;
	const headers = new Headers();
	for (const [name, value] of Object.entries(raw)) if (typeof value === "string") headers.set(name, value);
	return headers;
}

/** Google's `google.rpc.RetryInfo.retryDelay` (a duration such as "34s" or "0.5s") from a JSON error message. */
function googleRetryDelayMs(error: Error): number | undefined {
	const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(error.message);
	return match?.[1] === undefined ? undefined : Number.parseFloat(match[1]) * 1000;
}

/**
 * Retry delay a failed provider request asked for, in whole milliseconds, or `undefined` when the error carries no
 * usable delay: a `retry-after` header (OpenAI/Anthropic `Headers`, AWS SDK `$response.headers`) or Google's
 * `RetryInfo` detail, whose SDK error has no headers. Providers copy it onto the error assistant message so the
 * session retry can wait as long as the provider asked instead of using its own backoff.
 */
export function retryAfterMsFromError(error: unknown): number | undefined {
	let delayMs: number | undefined;
	const providerError = getProviderError(error);
	if (providerError) delayMs = parseRetryAfterMs(providerError.headers);
	if (delayMs === undefined && error instanceof Error) {
		delayMs = parseRetryAfterMs(awsResponseHeaders(error)) ?? googleRetryDelayMs(error);
	}
	return delayMs === undefined || !Number.isFinite(delayMs) || delayMs <= 0 ? undefined : Math.ceil(delayMs);
}

function getRetryDelayMs(error: ProviderError, retryIndex: number, maxRetryDelayMs: number | undefined): number {
	const serverDelayMs = parseRetryAfterMs(error.headers);
	if (serverDelayMs !== undefined) return validateRetryDelayMs(serverDelayMs, maxRetryDelayMs, error.message);

	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	return exponentialDelay * (1 - Math.random() * 0.25);
}

/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs while making
 * their backoff sleep interruptible. Their built-in retry timers ignore the
 * request AbortSignal, so callers must invoke the SDK with `maxRetries: 0` and
 * wrap the request with this helper. Provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero to
 * disable the limit.
 */
export async function retryProviderRequest<T>(
	request: () => Promise<T>,
	options: ProviderRetryOptions = {},
): Promise<T> {
	const maxRetries = options.maxRetries ?? 0;
	let retriesRemaining = maxRetries;

	for (;;) {
		try {
			// Each retry is a fresh SDK request, so X-Stainless-Retry-Count remains zero.
			return await request();
		} catch (error) {
			if (options.signal?.aborted) throw createAbortError();
			const providerError = getProviderError(error);
			if (retriesRemaining <= 0 || !providerError || !isRetryableProviderError(providerError)) throw error;
			if (providerError.status !== undefined && options.noRetryStatuses?.includes(providerError.status)) throw error;

			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining--;
			await sleepUnlessAborted(
				getRetryDelayMs(providerError, retryIndex, options.maxRetryDelayMs),
				options.signal,
				createAbortError,
			);
		}
	}
}
