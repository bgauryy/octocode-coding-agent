/**
 * Tells the user a model request is quiet: a request that sends nothing can sit in the provider's idle timeout for
 * minutes, and its retry only starts after that. `model_wait` carries how long the model has been silent; the terminal,
 * the web view and RPC clients all show it from that one event.
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

/** The line that says when the next attempt starts. */
export function retryText(attempt: number, maxAttempts: number, delayMs: number): string {
	return `Retry ${attempt} of ${maxAttempts} in ${seconds(delayMs)}`;
}

export class ModelWaitWatch {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private quietSince = 0;
	private shown = false;

	/** `emit` receives the quiet time in ms, and 0 once the quiet ends. */
	private readonly emit: (idleMs: number) => void;

	constructor(emit: (idleMs: number) => void) {
		this.emit = emit;
	}

	/** A request goes out at `turn_start`; any stream event proves it is answering; a finished message, turn or run ends the wait. */
	observe(event: AgentEvent): void {
		switch (event.type) {
			case "turn_start":
				this.arm();
				break;
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") this.arm();
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
		if (this.shown) {
			this.shown = false;
			this.emit(0);
		}
	}

	private arm(): void {
		clearTimeout(this.timer);
		if (this.shown) {
			this.shown = false;
			this.emit(0);
		}
		this.quietSince = Date.now();
		this.schedule(MODEL_WAIT_AFTER_MS);
	}

	private schedule(delayMs: number): void {
		this.timer = setTimeout(() => {
			this.shown = true;
			this.emit(Math.max(1, Date.now() - this.quietSince));
			this.schedule(MODEL_WAIT_REFRESH_MS);
		}, delayMs);
		this.timer.unref();
	}
}
