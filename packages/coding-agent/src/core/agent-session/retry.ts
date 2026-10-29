/** Automatic retry of failed agent responses, and the retry callbacks summaries share. */

import type { AgentEvent } from "@octocodeai/octocode-agent-core";
import { retryDelayMs } from "@octocodeai/octocode-ai";
import {
	type AssistantMessage,
	isContextOverflow,
	isRetryableAssistantError,
	type Model,
	type RetryCallbacks,
} from "@octocodeai/octocode-ai/compat";
import { sleepUnlessAborted } from "@octocodeai/octocode-ai/utils/abort";
import type { SessionInternals } from "./host.ts";
import type { AgentSessionEvent } from "./types.ts";

/** A provider quota or rate limit: every session on the same key shares it, so identical backoffs collide again. */
const RATE_LIMITED = /\b429\b|rate[ _-]?limit|too many requests/i;

/** A rate-limited response gets at least this many retries, because a token bucket refills while the session waits. */
export const RATE_LIMIT_MIN_RETRIES = 6;
/** Total time one session spends waiting on rate-limit retries before it reports the failure. */
export const RATE_LIMIT_WINDOW_MS = 180_000;
/** Spread added on top of a provider-requested delay, so sessions given the same `retry-after` do not return together. */
const RETRY_AFTER_SPREAD_MS = 1000;

/** Whether provider error text reports a rate limit or quota throttle (not a billing or quota exhaustion). */
export function isRateLimitedText(text: string): boolean {
	return RATE_LIMITED.test(text);
}

function isRateLimitedError(message: AssistantMessage): boolean {
	return isRateLimitedText(message.errorMessage ?? "");
}

/** Retries allowed for this failure: the configured budget, raised for rate limits unless retries are off. */
function retryBudget(maxRetries: number, message: AssistantMessage): number {
	if (maxRetries <= 0 || !isRateLimitedError(message)) return maxRetries;
	return Math.max(maxRetries, RATE_LIMIT_MIN_RETRIES);
}

/**
 * Delay before the next attempt. A rate-limited attempt waits up to half again the backoff, so parallel subagents
 * that hit one quota together spread their retries, and never less than the provider's `retry-after`. The result is
 * capped by `maxAgentDelayMs`. Other errors keep the exact exponential backoff.
 */
function retryDelayFor(
	backoffMs: number,
	message: AssistantMessage,
	maxAgentDelayMs: number | undefined,
	random: () => number = Math.random,
): number {
	if (!isRateLimitedError(message)) return backoffMs;
	const cap = maxAgentDelayMs === undefined ? Number.POSITIVE_INFINITY : Math.max(backoffMs, maxAgentDelayMs);
	const spread = Math.round(backoffMs + (backoffMs / 2) * random());
	const requested = message.retryAfterMs;
	const providerDelay =
		requested !== undefined && requested > 0 ? requested + Math.round(RETRY_AFTER_SPREAD_MS * random()) : 0;
	return Math.min(Math.max(spread, providerDelay), cap);
}

export interface RetryHost extends Pick<SessionInternals, "session" | "run" | "emit"> {
	modelForMessage(message: AssistantMessage): Model<any> | undefined;
	omitRecoveryAttempt(message: AssistantMessage): void;
}

/**
 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
 * stream drop no longer fails the whole operation. `source` carries the context
 * the TUI needs to render the retry and recreate the underlying indicator.
 */
export function summarizationRetryCallbacks(
	emit: (event: AgentSessionEvent) => void,
	source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
): RetryCallbacks {
	return {
		onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
			emit({
				type: "summarization_retry_scheduled",
				attempt,
				maxAttempts,
				delayMs,
				errorMessage,
			});
		},
		onRetryAttemptStart: () => {
			emit({
				type: "summarization_retry_attempt_start",
				...source,
			});
		},
		onRetryFinished: () => {
			emit({ type: "summarization_retry_finished" });
		},
	};
}

export class SessionRetry {
	private _abortController: AbortController | undefined = undefined;
	/** Current retry attempt (0 if not retrying) */
	attempt = 0;
	/** Milliseconds spent waiting on rate-limit retries since the last success, failure or cancellation. */
	private _rateLimitWaitedMs = 0;

	private readonly host: RetryHost;

	constructor(host: RetryHost) {
		this.host = host;
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._abortController !== undefined;
	}

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		const contextWindow = (this.host.modelForMessage(message) ?? this.host.session.model)?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;
		return isRetryableAssistantError(message);
	}

	willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		if (this.host.run.agentRunAbortRequested) return false;
		const settings = this.host.session.settingsManager.getRetrySettings();
		if (!settings.enabled) return false;

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return (
					this.attempt < retryBudget(settings.maxRetries, message) &&
					!this.rateLimitWindowSpent(message) &&
					this.isRetryableError(message)
				);
			}
		}
		return false;
	}

	/** Whether a rate-limited failure has already used up the time window for waiting. */
	private rateLimitWindowSpent(message: AssistantMessage): boolean {
		return isRateLimitedError(message) && this._rateLimitWaitedMs >= RATE_LIMIT_WINDOW_MS;
	}

	private resetAttempts(): void {
		this.attempt = 0;
		this._rateLimitWaitedMs = 0;
	}

	/** Reset the retry counter on a response that did not fail. */
	finishSucceeded(): void {
		this.host.emit({
			type: "auto_retry_end",
			success: true,
			attempt: this.attempt,
		});
		this.resetAttempts();
	}

	/** Report the final failure of a retried response. */
	finishFailed(message: AssistantMessage): void {
		this.host.emit({
			type: "auto_retry_end",
			success: false,
			attempt: this.attempt,
			finalError: message.errorMessage,
		});
		this.resetAttempts();
	}

	finishCancelled(): void {
		if (this.attempt === 0) return;
		const attempt = this.attempt;
		this.resetAttempts();
		this.host.emit({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	async prepare(message: AssistantMessage): Promise<boolean> {
		const settings = this.host.session.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this.attempt++;

		if (this.attempt > retryBudget(settings.maxRetries, message) || this.rateLimitWindowSpent(message)) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this.attempt--;
			return false;
		}

		let delayMs = retryDelayFor(retryDelayMs(settings, this.attempt), message, settings.maxAgentDelayMs);
		if (isRateLimitedError(message)) {
			delayMs = Math.min(delayMs, RATE_LIMIT_WINDOW_MS - this._rateLimitWaitedMs);
			this._rateLimitWaitedMs += delayMs;
		}

		this.host.emit({
			type: "auto_retry_start",
			attempt: this.attempt,
			maxAttempts: retryBudget(settings.maxRetries, message),
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Keep the failed attempt in raw history while durably omitting it from model projection.
		this.host.omitRecoveryAttempt(message);

		// Wait out the backoff or the provider's retry-after (abortable)
		this._abortController = new AbortController();
		try {
			await sleepUnlessAborted(delayMs, this._abortController.signal, () => new Error("Aborted"));
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			this.finishCancelled();
			return false;
		} finally {
			this._abortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abort(): void {
		this._abortController?.abort();
	}
}
