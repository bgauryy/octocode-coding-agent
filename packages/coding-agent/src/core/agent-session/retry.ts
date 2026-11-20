/** Automatic retry of failed agent responses, and the retry callbacks summaries share. */

import type { AgentEvent } from "@octocodeai/octocode-agent-core";
import {
	describeRetryOutcome,
	isMachineOffline,
	mayRetry,
	mayRetryOffline,
	planOfflineRetry,
	retryBudget,
	retryDelayFor,
} from "@octocodeai/octocode-ai";
import {
	type AssistantMessage,
	isContextOverflow,
	isRetryableAssistantError,
	type Model,
	type RetryCallbacks,
} from "@octocodeai/octocode-ai/compat";
import { createAbortError, sleepUnlessAborted } from "@octocodeai/octocode-ai/utils/abort";
import type { CustomMessage } from "../messages.ts";
import { formatDuration } from "../../utils/duration.ts";
import type { SessionInternals } from "./host.ts";
import type { AgentSessionEvent } from "./types.ts";

/** `customType` of the hidden note that tells the model the network was down. */
export const NETWORK_OUTAGE_MESSAGE_TYPE = "network_outage";

function clockTime(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** How an outage ended: the request went through, the user cancelled, the outage limit ran out, or the network came back to a different failure. */
export type OutageEnd = "resumed" | "cancelled" | "gave_up" | "network_back";

const OUTAGE_END_TEXT: Record<OutageEnd, (retries: string) => string> = {
	resumed: (retries) => `The network is back after ${retries}; this request resumes the turn.`,
	cancelled: (retries) => `The user cancelled the retry after ${retries}.`,
	gave_up: (retries) => `Retrying stopped at the configured outage limit after ${retries}; the request failed.`,
	network_back: (retries) =>
		`The network is back after ${retries}; the request now fails for another reason and is retried as usual.`,
};

/** What the model learns after an outage: how long it lasted, how it ended, and that the world moved on meanwhile. */
function networkOutageNote(since: number, until: number, attempts: number, end: OutageEnd): string {
	const lasted = formatDuration(until - since);
	const retries = `${attempts} ${attempts === 1 ? "retry" : "retries"}`;
	return `[Network was unavailable for ${lasted} (${clockTime(since)}–${clockTime(until)}). ${OUTAGE_END_TEXT[end](retries)} Time-dependent state (servers, CI, background jobs, peers) may have changed meanwhile.]`;
}

export { isRateLimitedText, RATE_LIMIT_MIN_RETRIES, RATE_LIMIT_WINDOW_MS } from "@octocodeai/octocode-ai";

export interface RetryHost extends Pick<SessionInternals, "session" | "run" | "emit"> {
	modelForMessage(message: AssistantMessage): Model<any> | undefined;
	omitRecoveryAttempt(message: AssistantMessage): void;
	/** Adds a context-only message the model reads on its next request. */
	deliverContextNote(message: CustomMessage): void;
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
		onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage, offlineSince) => {
			emit({
				type: "summarization_retry_scheduled",
				attempt,
				maxAttempts,
				delayMs,
				errorMessage,
				...(offlineSince === undefined ? {} : { offlineSince }),
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
	/** When the machine was first found offline in this series, while it still is. */
	private _offlineSince: number | undefined = undefined;
	/** Retries spent while offline, for the outage note. */
	private _offlineAttempts = 0;
	/** Length of the outage this series ended, for its end event. */
	private _outageMs: number | undefined = undefined;

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
				// An outage under way keeps retrying past the attempt cap; `prepare` asks the network again.
				const offline = this._offlineSince !== undefined && mayRetryOffline(settings, Date.now() - this._offlineSince);
				return (
					(offline ||
						mayRetry(
							this.attempt + 1,
							settings.maxRetries,
							message.errorMessage ?? "",
							this.sinceFirstFailureMs(),
							this.sinceFirstRequestMs(message),
						)) &&
					this.isRetryableError(message)
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
		this._outageMs = undefined;
	}

	/**
	 * Ends an outage: tells the model how long it lasted (a context-only note, never shown) and returns its length for the
	 * end event. An outage that already ended returns its length again; nothing when the machine was not offline.
	 */
	private endOutage(end: OutageEnd): number | undefined {
		const since = this._offlineSince;
		if (since === undefined) return this._outageMs;
		const until = Date.now();
		const attempts = this._offlineAttempts;
		this._offlineSince = undefined;
		this._offlineAttempts = 0;
		this.host.deliverContextNote({
			role: "custom",
			customType: NETWORK_OUTAGE_MESSAGE_TYPE,
			content: networkOutageNote(since, until, attempts, end),
			display: false,
			details: { since, until, attempts, end },
			timestamp: until,
		});
		this._outageMs = until - since;
		return this._outageMs;
	}

	/** Reset the retry counter on a response that did not fail. */
	finishSucceeded(): void {
		const offlineMs = this.endOutage("resumed");
		this.host.emit({
			type: "auto_retry_end",
			success: true,
			attempt: this.attempt,
			...(offlineMs === undefined ? {} : { offlineMs }),
		});
		this.resetAttempts();
	}

	/** Report the final failure of a retried response. */
	finishFailed(message: AssistantMessage): void {
		const offlineMs = this.endOutage("gave_up");
		this.host.emit({
			type: "auto_retry_end",
			success: false,
			attempt: this.attempt,
			finalError: describeRetryOutcome(
				message.errorMessage ?? "Unknown error",
				this.attempt + 1,
				this.sinceFirstRequestMs(message),
			),
			...(offlineMs === undefined ? {} : { offlineMs }),
		});
		this.resetAttempts();
	}

	finishCancelled(): void {
		if (this.attempt === 0) return;
		const attempt = this.attempt;
		const offlineMs = this.endOutage("cancelled");
		this.resetAttempts();
		this.host.emit({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
			...(offlineMs === undefined ? {} : { offlineMs }),
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

		const errorText = message.errorMessage ?? "";
		const offline = await planOfflineRetry(settings, errorText, this._offlineSince ?? Date.now());
		if (offline.kind === "online" && this._offlineSince !== undefined) {
			// The network is back and another failure took over: it gets the ordinary budget from the start.
			this.endOutage("network_back");
			this.resetAttempts();
		}
		this.attempt++;
		const elapsedMs = this.sinceFirstFailureMs();

		if (
			offline.kind === "stop" ||
			(offline.kind === "online" &&
				!mayRetry(this.attempt, settings.maxRetries, errorText, elapsedMs, this.sinceFirstRequestMs(message)))
		) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this.attempt--;
			return false;
		}

		this._firstFailureAt ??= Date.now();
		this._firstRequestAt ??= message.timestamp;
		if (offline.kind === "wait") {
			this._offlineSince = offline.since;
			this._offlineAttempts++;
		}
		const delayMs =
			offline.kind === "wait" ? offline.delayMs : retryDelayFor(settings, this.attempt, message, elapsedMs);

		this.host.emit({
			type: "auto_retry_start",
			attempt: this.attempt,
			maxAttempts: offline.kind === "wait" ? 0 : retryBudget(settings.maxRetries, errorText),
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
			...(offline.kind === "wait" ? { offlineSince: offline.since } : {}),
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

		// Back online: the note goes in before the retry, so the resumed request already knows how long it was away.
		if (this._offlineSince !== undefined && !(await isMachineOffline())) this.endOutage("resumed");
		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abort(): void {
		this._abortController?.abort();
	}
}
