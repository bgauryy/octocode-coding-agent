import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

/**
 * HTTP status codes standing alone: not digits inside a larger number ("max_tokens: 150000"), an index ("1500") or an
 * id ("toolu_01Ab429xYz"), so a permanent request error that quotes one does not read as a transient failure.
 */
function statusCodes(codes: string): string {
	return `(?<![A-Za-z0-9.])(?:${codes})(?![A-Za-z0-9]|\\.\\d)`;
}

const TERMINAL_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",

	// OpenAI's 429 billing codes: "Retrying billing, spend, or quota errors won't restore API access"
	// (https://developers.openai.com/api/docs/guides/error-codes).
	"credit_balance_exhausted",
	"(?:organization|project)_spend_limit_exceeded",
	"organization_usage_limit_exceeded",
	// Anthropic's spend caps: the tier cap is a 429 `rate_limit_error` without `retry-after` that "keeps failing until
	// access resumes" (code `enforced_spend_limit_reached`), and a self-set limit is a 400 that "starts with `You have
	// reached your specified API usage limits`" (https://platform.claude.com/docs/en/api/rate-limits).
	"enforced_spend_limit_reached",
	"reached your (?:specified )?(?:workspace )?API usage limits",

	// Sign in with ChatGPT: the subscription's shared usage limit, which resets
	// after hours rather than seconds.
	"subscription_sharing_usage_limit_exceeded",
	// Sign in with ChatGPT on a ChatGPT Business plan: a usage limit set by the
	// workspace admin. Only the admin can raise it.
	"subscription_sharing_workplace_individual_usage_limit_exceeded",

	// Zhipu/Z.ai (open.bigmodel.cn) error code 1308: the plan's usage limit is
	// reached, sent as HTTP 429. It resets after hours, not seconds.
	'"code"\\s*:\\s*"?1308(?![0-9])',
]);

/**
 * Bare Node socket error codes, e.g. "read ECONNRESET", "write EPIPE" or "connect ETIMEDOUT 1.2.3.4:443", when a
 * transport reports only the code; not part of a longer identifier such as a tool name.
 */
const SOCKET_ERROR_CODES = "(?<![A-Za-z0-9_])(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EPIPE)(?![A-Za-z0-9_])";

/** Dropped connections and streams that gateways and proxies relay as text of their own. */
const RELAYED_DROPS = [
	// A mid-stream drop relayed as an Anthropic-style `api_error` event, e.g.
	// {"type":"error","error":{"type":"api_error","message":"Connection closed."}}.
	"connection.?closed",
	"connection reset by peer",
	// A proxy around the Codex CLI relaying its mid-stream disconnect, e.g.
	// "stream disconnected before completion: stream closed before response.completed".
	"stream disconnected before completion",
	// A gateway relaying a dropped upstream Anthropic stream, e.g.
	// "Claude Code's stream from Anthropic was cut short after the reply had begun".
	"cut short after the reply had begun",
	// The Codex 60-minute WebSocket lifetime limit, as the code `websocket_connection_limit_reached` or the text
	// "Responses websocket connection limit reached". A retry opens a fresh connection.
	"websocket.?connection.?limit.?reached",
];

/**
 * Whether provider error text names an account, subscription or billing limit that resets after hours rather than
 * seconds. Every retry path (the session retry and each provider adapter) treats such an error as final.
 */
export function isTerminalProviderLimitError(errorText: string): boolean {
	return TERMINAL_PROVIDER_LIMIT_ERROR_PATTERN.test(errorText);
}

/** No funds: payment required, or no credit, balance or funds left on the account. */
const NO_FUNDS_PATTERN = buildProviderErrorPattern([
	statusCodes("402"),
	"payment required",
	"insufficient[ _](?:account[ _])?(?:quota|credit|balance|funds)",
	"out of credit",
]);

/**
 * Whether provider error text names a usage limit: an account, subscription, quota or billing limit, or no funds. The
 * same request to that account fails until the limit resets or funds are added, so callers may move to another model.
 */
export function isUsageLimitError(errorText: string): boolean {
	return isTerminalProviderLimitError(errorText) || NO_FUNDS_PATTERN.test(errorText);
}

/** The machine has no route to the network (sleep, VPN drop, network switch) or DNS failed for now. Not `ENOTFOUND`. */
const OFFLINE_PATTERN = buildProviderErrorPattern([
	"\\bENETUNREACH\\b",
	"\\bEHOSTUNREACH\\b",
	"\\bENETDOWN\\b",
	"\\bEAI_AGAIN\\b",
]);

/** Whether a failure says the network is unreachable for now: it clears when the connection returns. */
export function isOfflineText(text: string): boolean {
	return OFFLINE_PATTERN.test(text);
}

/** Transport wording a lost network also produces; whether the machine is offline is then asked of the network itself. */
const NETWORK_FAILURE_PATTERN = new RegExp(
	`${SOCKET_ERROR_CODES}|\\bENOTFOUND\\b|getaddrinfo|fetch failed|connection error|network error|socket hang up`,
	"i",
);

/** Whether a failure could come from the machine being offline (no route, unresolved host, a dropped transport). */
export function isNetworkFailureText(text: string): boolean {
	return isOfflineText(text) || NETWORK_FAILURE_PATTERN.test(text);
}

/**
 * A 4xx status other than 408, 409 and 429 (the statuses providers retry) leading the text, with invalid-request
 * wording. The provider refused this request, so resending it fails the same way even when a gateway wraps the
 * refusal as "Upstream request failed". A gateway `response.failed` event carries no status and keeps retrying.
 */
const REJECTED_REQUEST_PATTERN = /^\s*4(?!08\b|09\b|29\b)\d\d\b[\s\S]*invalid[_ ]?request/i;

function isRejectedRequestText(errorText: string): boolean {
	return REJECTED_REQUEST_PATTERN.test(errorText);
}

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"server_busy",
	"servers are currently busy",
	"currently experiencing high demand",
	"model is at capacity",
	"rate.?limit",
	"too many requests",
	statusCodes("429|500|502|503|504|520|524|529"),
	// Also matches "The service is temporarily unavailable" (#10965).
	"service.?(?:is.?)?(?:temporarily.?)?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264) and gateway wording such as
	// "The upstream provider returned an error" (#10842).
	"provider.?returned.?(?:an.?)?error",
	"exceeded request buffer limit while retrying upstream",
	// Gateway failure relaying the upstream response stream, sent as an OpenAI
	// Responses `response.failed` event without an error code (#10920).
	"unable to forward upstream",
	// Other gateway upstream failures relayed as `response.failed` error codes (#10920).
	"upstream.?request.?failed",
	"upstream_stream_read_error",
	"stream was interrupted",
	"http/?2 stream failed",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"connection.?reset",
	SOCKET_ERROR_CODES,
	...RELAYED_DROPS,
	"other side closed",
	"fetch failed",
	// node-fetch system errors, e.g. the Google ADC OAuth token refresh used by
	// google-vertex. The reason is often empty (#10996).
	"request to \\S+ failed, reason:",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"ENETDOWN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	// Whole words only, so a name such as "timeout_tool" in a request error does not read as a transient failure.
	"\\btimed? out\\b",
	"\\btimeout\\b",
	"\\bterminated\\b",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",
	// Node ERR_HTTP2_STREAM_CANCEL: the HTTP/2 session died before the request was
	// sent, e.g. after the Bedrock SDK's 5-minute session timeout (#10379).
	"pending stream has been canceled",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",

	// Sign in with ChatGPT: usage or user data temporarily unavailable. Usage
	// failures can arrive mid-stream without an HTTP 503 in the message.
	"subscription_sharing_usage_unavailable",
	"subscription_sharing_user_unavailable",
]);

const RATE_LIMITED_PATTERN = buildProviderErrorPattern([statusCodes("429"), "rate[ _-]?limit", "too many requests"]);

/**
 * Failures that clear by themselves within minutes: the provider is short of capacity, or the connection to it broke.
 * Deliberately not every retryable error. The retryable pattern also matches errors that never clear (`ENOTFOUND`,
 * `getaddrinfo`, a bare `500` from a bad request), and each attempt resends the whole context.
 */
const CAPACITY_OR_TRANSPORT_PATTERN = buildProviderErrorPattern([
	"overloaded",
	"server_busy",
	"servers are currently busy",
	"currently experiencing high demand",
	"model is at capacity",
	statusCodes("502|503|504|520|524|529"),
	"service.?(?:is.?)?(?:temporarily.?)?unavailable",

	// Connection resets, and sockets or websockets closed under the request.
	"connection.?reset",
	SOCKET_ERROR_CODES,
	...RELAYED_DROPS,
	"connection.?lost",
	"reset before headers",
	"other side closed",
	"socket hang up",
	"socket connection was closed",
	"websocket.?closed",
	"\\bterminated\\b",

	// A stream that ended before its terminal event.
	"stream.?ended",
	"stream was interrupted",
	"upstream_stream_read_error",
	"http/?2 stream failed",
	"http2 request did not get a response",
	"pending stream has been canceled",
]);

/** Whether provider error text reports a rate limit or quota throttle (not a billing or quota exhaustion). */
export function isRateLimitedText(text: string): boolean {
	return RATE_LIMITED_PATTERN.test(text);
}

/** A host that does not resolve: transports wrap this in text that otherwise reads as a dropped connection. */
const UNRESOLVED_HOST_PATTERN = buildProviderErrorPattern(["getaddrinfo", "ENOTFOUND"]);

/** Whether a failure is expected to clear by waiting: a rate limit, or a capacity or transport failure. */
export function clearsWithWaiting(text: string): boolean {
	if (UNRESOLVED_HOST_PATTERN.test(text)) return false;
	return isRateLimitedText(text) || CAPACITY_OR_TRANSPORT_PATTERN.test(text);
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	return isRetryableErrorText(message.errorMessage);
}

/** {@link isRetryableAssistantError} for text a caller holds without the message, such as a run's recorded outcome. */
export function isRetryableErrorText(errorMessage: string): boolean {
	if (isTerminalProviderLimitError(errorMessage)) return false;
	if (isRejectedRequestText(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
