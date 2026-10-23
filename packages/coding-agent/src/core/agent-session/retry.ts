/** Automatic retry of failed agent responses, and the retry callbacks summaries share. */

import type { AgentEvent, AgentMessage } from "@octocodeai/octocode-agent-core";
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

export interface RetryHost extends Pick<SessionInternals, "session" | "run" | "emit"> {
	modelForMessage(message: AssistantMessage): Model<any> | undefined;
	omitRecoveryAttempt(message: AssistantMessage, toolResults?: AgentMessage[]): void;
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
		if (!settings.enabled || this.attempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this.isRetryableError(message);
			}
		}
		return false;
	}

	/** Reset the retry counter on a response that did not fail. */
	finishSucceeded(): void {
		this.host.emit({
			type: "auto_retry_end",
			success: true,
			attempt: this.attempt,
		});
		this.attempt = 0;
	}

	/** Report the final failure of a retried response. */
	finishFailed(message: AssistantMessage): void {
		this.host.emit({
			type: "auto_retry_end",
			success: false,
			attempt: this.attempt,
			finalError: message.errorMessage,
		});
		this.attempt = 0;
	}

	finishCancelled(): void {
		if (this.attempt === 0) return;
		const attempt = this.attempt;
		this.attempt = 0;
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

		if (this.attempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this.attempt--;
			return false;
		}

		const delayMs = retryDelayMs(settings, this.attempt);

		this.host.emit({
			type: "auto_retry_start",
			attempt: this.attempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Keep the failed attempt in raw history while durably omitting it from model projection.
		this.host.omitRecoveryAttempt(message);

		// Wait with exponential backoff (abortable)
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
