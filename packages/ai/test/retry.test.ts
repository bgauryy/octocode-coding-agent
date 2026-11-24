import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { clearsWithWaiting, isTerminalProviderLimitError } from "../src/utils/retry-classes.ts";
import {
	isRateLimitedText,
	isRetryableAssistantError,
	RATE_LIMIT_MIN_RETRIES,
	RATE_LIMIT_WINDOW_MS,
	TIMEOUT_RETRY_WINDOW_MS,
	describeRetryOutcome,
	mayRetry,
	type RetryPolicy,
	retryAssistantCall,
	retryBudget,
	retryDelayMs,
} from "../src/utils/retry.ts";

const openAIExplicitRetryMessage =
	"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message.";
const bedrockExplicitRetryMessage =
	'{"message":"The system encountered an unexpected error during processing. Try your request again."}';
const nvidiaNIMResourceExhaustedMessage = "ResourceExhausted: Worker local total request limit reached (288/48)";
const bunFetchSocketClosedMessage =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const openAIResponsesEarlyEofMessage = "OpenAI Responses stream ended before a terminal response event";
const wrappedDnsLookupError =
	"The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com)";
const azurePeakLoadError =
	"The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load. For improved capacity reliability, consider switching to Provisioned Throughput.";

describe("provider retry classification", () => {
	it("matches explicit provider retry guidance", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bedrockExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: nvidiaNIMResourceExhaustedMessage }),
			),
		).toBe(true);
	});

	it.each([
		"400 Upstream request failed: [invalid_request_error] Invalid request",
		"422 Upstream request failed: [invalid_request_error] Invalid request",
		JSON.stringify({
			error: {
				type: "invalid_request_error",
				code: "validation_error",
				message:
					"Mantle streaming error for requestId 00000000-0000-4000-8000-000000000001: The task request was rejected by the target",
			},
		}),
	])("does not retry a refused request that a gateway words as an upstream failure: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it.each([
		"Upstream request failed",
		"upstream request failed: server_error",
		"429 Upstream request failed: invalid_request rate limit",
		"408 Upstream request failed: invalid_request_error",
	])("still retries a gateway failure without a refusing status: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each([
		'400 {"error":"max_tokens: 150000 > 64000, which is the maximum allowed"}',
		"400 invalid request: messages.1500.content is empty",
		// Digits inside an id are not a status code.
		"400 messages: tool_use ids were found without tool_result blocks: toolu_01Ab429xYz",
		"400 messages: tool_use ids were found without tool_result blocks: toolu_01X500kQ",
		"400 unknown tool call call_503a",
		'400 tool "timeout_tool" has an invalid schema',
	])(
		"does not retry a deterministic request error whose text only contains a status-like number or word: %s",
		(errorMessage) => {
			expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
		},
	);

	it.each([
		"HTTP 429",
		"OpenAI API error (500): server failed",
		"request timeout",
		"Request timed out",
		"terminated",
		"529 status code (no body)",
		"read ECONNRESET",
		"connection reset by peer",
	])("still retries a standalone transient status or word: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it("matches Bun fetch socket drop wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bunFetchSocketClosedMessage }),
			),
		).toBe(true);
	});

	it("matches upstream request buffer exhaustion wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Error: exceeded request buffer limit while retrying upstream",
				}),
			),
		).toBe(true);
	});

	it.each([
		wrappedDnsLookupError,
		"connect ENOTFOUND api.example.com",
		"EAI_AGAIN api.example.com",
		"getaddrinfo failed for api.example.com",
	])("matches DNS transport failure wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each(["The pending stream has been canceled", "The pending stream has been canceled (caused by: socket closed)"])(
		"matches HTTP/2 pending stream cancellation: %s",
		(errorMessage) => {
			// Regression for #10379.
			expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
		},
	);

	it.each([
		// Regression for #10965 (provider unknown, no status code in the message).
		"The service is temporarily unavailable. Please retry later.",
		// Bedrock ServiceUnavailableException as formatted by formatBedrockError.
		"Service unavailable: The service is temporarily unavailable.",
	])("matches service unavailable wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each([
		// Regression for #10996: node-fetch errors from the google-vertex OAuth token refresh.
		"request to https://oauth2.googleapis.com/token failed, reason:",
		"request to https://oauth2.googleapis.com/token failed, reason: connect ECONNREFUSED 127.0.0.1:9",
	])("matches node-fetch request failure wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each([
		// Regression for #10920: gateway upstream failures sent as `response.failed` error codes.
		"unknown: Unable to forward upstream stream",
		"upstream_error: Upstream request failed",
		"upstream_stream_read_error: Upstream response stream was interrupted",
		"Upstream HTTP/2 stream failed",
	])("matches gateway upstream failure wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it("matches OpenAI Responses streams that end before terminal events", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIResponsesEarlyEofMessage }),
			),
		).toBe(true);
	});

	it("matches Azure peak-load capacity errors", () => {
		// Regression for #9669.
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: azurePeakLoadError })),
		).toBe(true);
	});

	it("keeps provider limit errors non-retryable", () => {
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" })),
		).toBe(false);
	});

	it.each([
		// A gateway's mid-stream drop relayed as an Anthropic-style `api_error` event.
		'{"type":"error","error":{"type":"api_error","message":"Connection closed."}}',
		// A gateway relaying a dropped upstream Anthropic stream.
		"Claude Code's stream from Anthropic was cut short after the reply had begun",
		// A proxy around the Codex CLI relaying its mid-stream disconnect.
		"stream disconnected before completion: stream closed before response.completed",
		// The Codex WebSocket lifetime limit; a retry opens a fresh connection.
		"websocket_connection_limit_reached: Responses websocket connection limit reached",
		// Transports that report only the Node socket error code.
		"write EPIPE",
		"connect ETIMEDOUT 1.2.3.4:443",
		"read ECONNABORTED",
		"connect ECONNREFUSED 127.0.0.1:443",
		"read: connection reset by peer",
	])("retries a dropped connection or stream: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
		expect(clearsWithWaiting(errorMessage)).toBe(true);
	});

	it("does not read a socket code inside a longer identifier as a dropped connection", () => {
		const errorMessage = "400 tool 'EPIPE_handler' has an invalid schema";
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it.each([
		// Zhipu/Z.ai: the plan's usage limit, sent as HTTP 429; it resets after hours.
		'429 {"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-11-18 06:00:00"}}',
		'{"code": 1308, "message": "Usage limit reached"}',
		// ChatGPT Business: a per-user limit the workspace admin set.
		'OpenAI API error (429): {"code":"subscription_sharing_workplace_individual_usage_limit_exceeded"}',
	])("treats an account usage limit as final: %s", (errorMessage) => {
		expect(isTerminalProviderLimitError(errorMessage)).toBe(true);
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it("still retries a 429 whose code only starts with 1308", () => {
		const errorMessage = '429 {"code":"13080","message":"rate limited"}';
		expect(isTerminalProviderLimitError(errorMessage)).toBe(false);
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it("keeps the ChatGPT subscription usage limit non-retryable", () => {
		const errorMessage =
			'OpenAI API error (429): {"code":"subscription_sharing_usage_limit_exceeded","message":"Usage limit reached."}';
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it.each([
		"subscription_sharing_usage_unavailable: Usage cannot be checked.",
		"subscription_sharing_user_unavailable: User cannot be loaded.",
	])("retries temporary ChatGPT subscription errors: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it("classifies assistant error messages", () => {
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })),
		).toBe(true);
		// Regression for #9627.
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "520 status code (no body)" }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "524 status code (no body)" }),
			),
		).toBe(true);
		expect(isRetryableAssistantError(fauxAssistantMessage("not an error"))).toBe(false);
	});
});

describe("retryBudget", () => {
	it("does not raise the budget for a failure that names a host that will not resolve", () => {
		expect(retryBudget(2, wrappedDnsLookupError)).toBe(2);
		expect(retryBudget(2, "fetch failed: getaddrinfo ENOTFOUND api.example.com")).toBe(2);
		expect(retryBudget(2, "The pending stream has been canceled")).toBe(RATE_LIMIT_MIN_RETRIES);
	});

	it("does not read a status code out of an id as a rate limit", () => {
		expect(isRateLimitedText("toolu_01Ab429xYz")).toBe(false);
		expect(isRateLimitedText("HTTP 429")).toBe(true);
	});
});

describe("retryDelayMs", () => {
	it("caps agent retry delay", () => {
		// Regression for #8826.
		expect(retryDelayMs({ baseDelayMs: 2000 }, 6)).toBe(60000);
		expect(retryDelayMs({ baseDelayMs: 2000, maxAgentDelayMs: 5000 }, 5)).toBe(5000);
		expect(retryDelayMs({ baseDelayMs: 2000, maxAgentDelayMs: 0 }, 5)).toBe(0);
	});
});

describe("retryAssistantCall", () => {
	const disabled: RetryPolicy = { enabled: false, maxRetries: 3, baseDelayMs: 0 };
	const enabled: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 0 };

	it("returns a successful response immediately without retrying", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("ok"));
		const res = await retryAssistantCall(produce, enabled, undefined);
		expect(res.content).toEqual([{ type: "text", text: "ok" }]);
		expect(produce).toHaveBeenCalledTimes(1);
	});

	it("does not retry an aborted message", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "aborted" }));
		const onRetryScheduled = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled });
		expect(res.stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
	});

	it("does not retry a non-retryable error (quota/billing)", async () => {
		const produce = vi.fn(async () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
		);
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(onRetryFinished).not.toHaveBeenCalled();
	});

	it("retries a transient error up to maxRetries then returns the final error", async () => {
		const produce = vi.fn(async () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "request timeout" }),
		);
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
		expect(onRetryScheduled).toHaveBeenCalledTimes(3);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 3, "request timeout");
	});

	it("gives a capacity or transport failure the raised budget of an agent turn", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const onRetryScheduled = vi.fn();
		await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled });
		expect(produce).toHaveBeenCalledTimes(1 + RATE_LIMIT_MIN_RETRIES);
		expect(onRetryScheduled.mock.calls[0]?.[1]).toBe(RATE_LIMIT_MIN_RETRIES);
	});

	it("waits at least what a capacity failure's retry-after asked for", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n === 1
				? { ...fauxAssistantMessage("", { stopReason: "error", errorMessage: "503" }), retryAfterMs: 20 }
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn();
		await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled });
		expect(onRetryScheduled.mock.calls[0]?.[2]).toBeGreaterThanOrEqual(20);
	});

	it("stops the raised attempts when the wall-clock window is spent, keeping the configured ones", async () => {
		const real = Date.now.bind(Date);
		let offset = 0;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
		try {
			const produce = vi.fn(async () => {
				offset += RATE_LIMIT_WINDOW_MS;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });
			});
			await retryAssistantCall(produce, { enabled: true, maxRetries: 2, baseDelayMs: 0 }, undefined);
			expect(produce).toHaveBeenCalledTimes(3);
		} finally {
			clock.mockRestore();
		}
	});

	it("reports capped retry delays", async () => {
		// Regression for #8826.
		let n = 0;
		const policy: RetryPolicy = { enabled: true, maxRetries: 4, baseDelayMs: 10, maxAgentDelayMs: 15 };
		const produce = vi.fn(async () => {
			n++;
			return n < 5
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "request timeout" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn();

		await retryAssistantCall(produce, policy, undefined, { onRetryScheduled });

		expect(onRetryScheduled.mock.calls.map((call) => call[2])).toEqual([10, 15, 15, 15]);
	});

	it("stops retrying once a call succeeds", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n < 3
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(produce).toHaveBeenCalledTimes(3);
		expect(onRetryFinished).toHaveBeenCalledWith(true, 2);
	});

	it("reports an aborted retried call as unsuccessful", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n === 1
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("", { stopReason: "aborted" });
		});
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
		expect(res.stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(2);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1);
	});

	it("does not retry when policy is disabled", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, disabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(onRetryFinished).not.toHaveBeenCalled();
	});

	it("emits onRetryAttemptStart after backoff before each retried call", async () => {
		const events: string[] = [];
		let n = 0;
		const produce = vi.fn(async () => {
			events.push(`produce:${n}`);
			n++;
			return n < 3
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn((attempt: number) => {
			events.push(`retry:${attempt}`);
		});
		const onRetryAttemptStart = vi.fn(() => {
			events.push("attempt-start");
		});
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryAttemptStart });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(onRetryScheduled).toHaveBeenCalledTimes(2);
		expect(onRetryAttemptStart).toHaveBeenCalledTimes(2);
		expect(events).toEqual([
			"produce:0",
			"retry:1",
			"attempt-start",
			"produce:1",
			"retry:2",
			"attempt-start",
			"produce:2",
		]);
	});

	it("aborts backoff sleep via signal, returns an aborted message, and emits onRetryFinished(false)", async () => {
		const controller = new AbortController();
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const policy: RetryPolicy = { enabled: true, maxRetries: 5, baseDelayMs: 10_000 };
		const onRetryFinished = vi.fn();
		const p = retryAssistantCall(produce, policy, controller.signal, { onRetryFinished });
		// Let one error call resolve and the first backoff sleep start, then abort.
		await vi.waitFor(() => expect(produce).toHaveBeenCalled());
		controller.abort();
		const res = await p;
		expect(res.stopReason).toBe("aborted");
		expect(res.errorMessage).toBeUndefined();
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1, "terminated");
	});
	it("reads a status code that ends a sentence, as a status, but not a decimal", () => {
		const retryable = (errorMessage: string) =>
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }));
		expect(retryable("Upstream returned 502.")).toBe(true);
		expect(retryable("cost is 502.25 dollars")).toBe(false);
	});
});

describe("timeout retries", () => {
	const timedOut = "Model stream idle: no data received for 300000ms (timed out)";

	it("allows configured attempts until the first request's age reaches the timeout window", () => {
		expect(mayRetry(1, 3, timedOut, 0, TIMEOUT_RETRY_WINDOW_MS - 1)).toBe(true);
		expect(mayRetry(1, 3, timedOut, 0, TIMEOUT_RETRY_WINDOW_MS)).toBe(false);
		// Other failures keep every configured attempt however long the requests took.
		expect(mayRetry(3, 3, "503 Service Unavailable", 0, TIMEOUT_RETRY_WINDOW_MS * 5)).toBe(true);
	});

	it("bounds a loop of stalled requests to the window, not to the configured attempts", async () => {
		const real = Date.now.bind(Date);
		let offset = 0;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
		let calls = 0;
		try {
			const policy: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 1 };
			const result = await retryAssistantCall(
				async () => {
					calls++;
					offset += 300_000;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: timedOut });
				},
				policy,
				undefined,
			);
			expect(result.stopReason).toBe("error");
			expect(calls).toBe(2);
		} finally {
			clock.mockRestore();
		}
	});

	it("describes attempts and elapsed time", () => {
		expect(describeRetryOutcome("boom", 3, 905_400)).toBe("boom (3 attempts over 905s)");
		expect(describeRetryOutcome("boom", 1, 1000)).toBe("boom (1 attempt over 1s)");
	});

	it("keeps the attempts note on the error's first line, before a fix line", () => {
		expect(describeRetryOutcome("p/m: invalid_api_key\nFix: /providers → P", 2, 3000)).toBe(
			"p/m: invalid_api_key (2 attempts over 3s)\nFix: /providers → P",
		);
	});
});
