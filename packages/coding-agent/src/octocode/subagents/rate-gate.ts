import { isRateLimitedText } from "../../core/agent-session/retry.ts";
import { sleepUnlessAborted } from "@octocodeai/octocode-ai/utils/abort";

/**
 * Shared pause for starting subagents after one failed on a provider rate limit. Every child uses the same key, so the
 * next child would meet the same throttle: new starts wait briefly instead, and each further rate-limit failure within
 * the cool-down window doubles the pause up to a cap. The child already retried with the provider's `retry-after` before
 * it failed, so this only spaces out the launches that follow.
 */

const INITIAL_PAUSE_MS = 5_000;
const MAX_PAUSE_MS = 30_000;
/** A failure this long after the previous pause ended starts the backoff over. */
const FORGET_AFTER_MS = 60_000;

export class StartGate {
	private until = 0;
	private pauseMs = 0;
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** Records a failed child's error text; only a rate limit pauses new starts. */
	noteFailure(error: string | undefined): void {
		if (!error || !isRateLimitedText(error)) return;
		const now = this.now();
		this.pauseMs = now - this.until > FORGET_AFTER_MS ? INITIAL_PAUSE_MS : Math.min(this.pauseMs * 2, MAX_PAUSE_MS);
		this.until = now + this.pauseMs;
	}

	/** Milliseconds until a new child may start; 0 when no pause is active. */
	remainingMs(): number {
		return Math.max(0, this.until - this.now());
	}

	/** Waits out an active pause; the signal (Esc, a turn abort) gives up the wait. */
	async wait(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const remaining = this.remainingMs();
		if (remaining > 0)
			await sleepUnlessAborted(remaining, signal, () => new Error("Cancelled while waiting out a rate limit."));
	}
}

/** One gate per parent process: its subagents share the provider key and so the limit. */
export const startGate = new StartGate();
