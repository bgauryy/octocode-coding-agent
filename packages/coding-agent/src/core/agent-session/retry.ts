/** Automatic retry of failed agent responses, and the retry callbacks summaries share. */

import type { AgentEvent } from "@octocodeai/octocode-agent-core";
import { describeRetryOutcome, mayRetry, retryBudget, retryDelayFor } from "@octocodeai/octocode-ai";
import {
	type AssistantMessage,
	isContextOverflow,
	isRetryableAssistantError,
	type Model,
	type RetryCallbacks,
} from "@octocodeai/octocode-ai/compat";
import { createAbortError, sleepUnlessAborted } from "@octocodeai/octocode-ai/utils/abort";
import type { SessionInternals } from "./host.ts";
import type { AgentSessionEvent } from "./types.ts";

export { isRateLimitedText, RATE_LIMIT_MIN_RETRIES, RATE_LIMIT_WINDOW_MS } from "@octocodeai/octocode-ai";

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
	/** When the failure that started this run of retries happened; cleared by a success, a final failure or a cancellation. */
	private _firstFailureAt: number | undefined = undefined;
	/** When the first request of this run of retries began (its message timestamp), so the final error can name the whole stall. */
	private _firstRequestAt: number | undefined = undefined;

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
					mayRetry(
						this.attempt + 1,
						settings.maxRetries,
						message.errorMessage ?? "",
						this.sinceFirstFailureMs(),
						this.sinceFirstRequestMs(message),
					) && this.isRetryableError(message)
				);
			}
		}
		return false;
	}

	/** Wall-clock time since the first failure, so a request that stalls before failing spends the window as a sleep does. */
	private sinceFirstFailureMs(): number {
		return this._firstFailureAt === undefined ? 0 : Date.now() - this._firstFailureAt;
	}

	/** Wall-clock time since the first request of this series began, including the failing request just ended. */
	private sinceFirstRequestMs(failed: AssistantMessage): number {
		return Date.now() - (this._firstRequestAt ?? failed.timestamp ?? Date.now());
	}

	private resetAttempts(): void {
		this.attempt = 0;
		this._firstFailureAt = undefined;
		this._firstRequestAt = undefined;
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
			finalError: describeRetryOutcome(
				message.errorMessage ?? "Unknown error",
				this.attempt + 1,
				this.sinceFirstRequestMs(message),
			),
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
		const errorText = message.errorMessage ?? "";
		const elapsedMs = this.sinceFirstFailureMs();

		if (!mayRetry(this.attempt, settings.maxRetries, errorText, elapsedMs, this.sinceFirstRequestMs(message))) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this.attempt--;
			return false;
		}

		this._firstFailureAt ??= Date.now();
		this._firstRequestAt ??= message.timestamp;
		const delayMs = retryDelayFor(settings, this.attempt, message, elapsedMs);

		this.host.emit({
			type: "auto_retry_start",
			attempt: this.attempt,
			maxAttempts: retryBudget(settings.maxRetries, errorText),
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Keep the failed attempt in raw history while durably omitting it from model projection.
		this.host.omitRecoveryAttempt(message);

		// Wait out the backoff or the provider's retry-after (abortable)
		this._abortController = new AbortController();
		try {
			await sleepUnlessAborted(delayMs, this._abortController.signal, createAbortError);
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
