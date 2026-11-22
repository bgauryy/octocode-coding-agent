/**
 * Tells the user a model request is quiet: a request that sends nothing can sit in the provider's idle timeout for
 * minutes, and its retry only starts after that. `model_wait` carries how long the model has been silent; the terminal,
 * the web view and RPC clients all show it from that one event. Features hear of it once per request (`model_stall`).
 */

import type { AgentEvent } from "@octocodeai/octocode-agent-core";

/** Silence before the user is told. Shorter pauses are ordinary (time to first token, long thinking). */
export const MODEL_WAIT_AFTER_MS = 20_000;
/** How often the quiet time is refreshed while it lasts. */
const MODEL_WAIT_REFRESH_MS = 5_000;

function seconds(ms: number): string {
	const total = Math.round(ms / 1000);
	return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** The line that says the model is quiet. */
export function modelWaitText(idleMs: number): string {
	return `Model not answering for ${seconds(idleMs)}`;
}

/** A request waiting out its provider's rate-limit cool-down: whose, and until when (ms since the epoch). */
export interface CooldownWait {
	provider: string;
	until: number;
}

/** The line that says a request waits for its provider's rate limit; when it goes out travels beside it. */
export function cooldownWaitText(provider: string): string {
	return `Waiting out ${provider} rate limit`;
}

/** The line that names the retry; when it starts travels beside it, so a client can count down. */
export function retryText(attempt: number, maxAttempts: number): string {
	return maxAttempts > 0 ? `Retry ${attempt} of ${maxAttempts}` : `Retry ${attempt}`;
}

const SYSTEM_ERROR_CODE = /\b(E[A-Z]{2,}(?:_[A-Z]+)*)\b/;
const SHORT_FAILURE_MAX_CHARS = 60;

/** A failure in a few words: its first clause, plus the system error code when the clause lacks it (`fetch failed (ENOTFOUND)`). */
function shortFailureText(errorMessage: string): string {
	const firstLine = errorMessage.trim().split("\n")[0] ?? "";
	const clause = (firstLine.split(/:\s/)[0] ?? firstLine).replace(/[.\s]+$/, "");
	const head =
		clause.length > SHORT_FAILURE_MAX_CHARS ? `${clause.slice(0, SHORT_FAILURE_MAX_CHARS - 1).trimEnd()}…` : clause;
	const code = SYSTEM_ERROR_CODE.exec(errorMessage)?.[1];
	if (!head) return code ?? "Unknown error";
	return code && !head.includes(code) ? `${head} (${code})` : head;
}

/** The one line an outage shows; the client appends its countdown (` - trying again in 42s`). */
export function offlineRetryText(failedAttempts: number, errorMessage: string): string {
	return `Retry failed after ${failedAttempts} attempt${failedAttempts === 1 ? "" : "s"}: ${shortFailureText(errorMessage)}`;
}

/**
 * Counts the silence of the request in flight. It starts when the request goes out (`requestSent`), not at the turn's
 * start, so the work that prepares a request (a compaction, input hooks) never counts as the model's silence. A streamed
 * event only moves the last-activity time; one timer reads it.
 */
export class ModelWaitWatch {
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** When the request went out or last streamed; 0 while no request is out. */
	private lastActivity = 0;
	private shown = false;
	/** The request out now was already reported as stalled: a later silence of the same request is not news. */
	private stallReported = false;

	/** The request waits out its provider's rate-limit cool-down and has not gone out. */
	private cooling = false;

	/** `emit` receives the quiet time in ms, and 0 once the quiet ends; with `cooldown`, the wait for a cool-down. */
	private readonly emit: (idleMs: number, cooldown?: CooldownWait) => void;
	/** `stalled` receives the quiet time the first time a request's silence is shown, at most once per request. */
	private readonly stalled: ((idleMs: number) => void) | undefined;

	constructor(emit: (idleMs: number, cooldown?: CooldownWait) => void, stalled?: (idleMs: number) => void) {
		this.emit = emit;
		this.stalled = stalled;
	}

	/** The provider request went out: its silence counts from now. */
	requestSent(): void {
		this.stallReported = false;
		this.active();
		if (!this.timer) this.schedule(MODEL_WAIT_AFTER_MS);
	}

	/**
	 * The request waits out its provider's cool-down (`wait`), or that wait is over (`undefined`) and it goes out now. The
	 * wait is shown as such and never counts as the model's silence, which counts from when the request goes out.
	 */
	cooldown(wait: CooldownWait | undefined): void {
		if (wait) {
			clearTimeout(this.timer);
			this.timer = undefined;
			this.lastActivity = 0;
			this.shown = false;
			this.cooling = true;
			this.emit(0, wait);
			return;
		}
		if (!this.cooling) return;
		this.cooling = false;
		this.emit(0);
		this.requestSent();
	}

	/** A stream event of the request proves it is answering; a finished message, turn or run ends the wait. */
	observe(event: AgentEvent): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
				// A delta delivered after its run ended finds no request out and starts nothing.
				if (event.message.role === "assistant" && this.lastActivity > 0) this.active();
				break;
			case "message_end":
				if (event.message.role === "assistant") this.stop();
				break;
			case "turn_end":
			case "agent_end":
				this.stop();
				break;
			default:
		}
	}

	/** Ends the wait; the user is told if it had been shown. */
	stop(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.lastActivity = 0;
		if (this.cooling) {
			this.cooling = false;
			this.emit(0);
		}
		this.unshow();
	}

	private active(): void {
		this.lastActivity = Date.now();
		this.unshow();
	}

	private unshow(): void {
		if (!this.shown) return;
		this.shown = false;
		this.emit(0);
	}

	private schedule(delayMs: number): void {
		this.timer = setTimeout(() => this.check(), delayMs);
		this.timer.unref();
	}

	/** Shows the silence once it is long enough, and looks again when it next could be. */
	private check(): void {
		this.timer = undefined;
		if (this.lastActivity === 0) return;
		const idleMs = Date.now() - this.lastActivity;
		if (idleMs < MODEL_WAIT_AFTER_MS) return this.schedule(MODEL_WAIT_AFTER_MS - idleMs);
		this.shown = true;
		this.emit(idleMs);
		if (!this.stallReported) {
			this.stallReported = true;
			this.stalled?.(idleMs);
		}
		this.schedule(MODEL_WAIT_REFRESH_MS);
	}
}
