/**
 * Waiting out a usage limit. Unattended, the run waits in place until the reset (`waitUntil`): print mode, an ACP
 * session and a child end when their run does, so the run must outlast the wait. Interactive, the turn ends and a
 * resume timer (`ResumeTimer`) sends "Continue" at the reset: the person keeps the session and may type meanwhile.
 *
 * The resume timer lives in this process, not in the agent database's timers. A stored timer would fire only while some
 * process holds the session, so it would add nothing to a closed terminal; it would wake the model with a timer notice
 * instead of resuming the turn, and count against the session's ten active timers and its timer spending cap. In memory,
 * a new run (typed, queued or sent from /web) or the session's end (`/new`, `/resume`, exit) cancels it at no cost.
 */

import type { Agent } from "@octocodeai/octocode-agent-core";
import { sharedClock } from "@octocodeai/octocode-common/clock";
import { registerSessionResourceCleanup } from "@octocodeai/octocode-ai";
import type { SessionRunState } from "./host.ts";

/** The longest delay `setTimeout` takes (2^31 − 1 ms, about 24.8 days); a longer wait is taken in steps. */
const MAX_TIMER_MS = 2_147_483_647;
/** How often a wait looks whether the run was stopped: the session's abort sets a flag and has no signal between turns. */
const ABORT_POLL_MS = 250;

/** A signal that aborts once the run is stopped (`agentRunAbortRequested`); `stop()` ends the watch. */
export function runAbortSignal(run: Pick<SessionRunState, "agentRunAbortRequested">): {
	signal: AbortSignal;
	stop(): void;
} {
	const controller = new AbortController();
	const stop = sharedClock.subscribe(
		() => {
			if (!run.agentRunAbortRequested) return;
			stop();
			controller.abort();
		},
		{ everyMs: ABORT_POLL_MS },
	);
	return { signal: controller.signal, stop };
}

/** Resolves true at `at` (ms since the epoch), false as soon as `signal` aborts. */
export function waitUntil(at: number, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve(false);
		let timer: ReturnType<typeof setTimeout>;
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		const step = () => {
			const left = at - Date.now();
			if (left <= 0) {
				signal.removeEventListener("abort", onAbort);
				return resolve(true);
			}
			timer = setTimeout(step, Math.min(left, MAX_TIMER_MS));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		step();
	});
}

export interface ResumeTimerHost {
	readonly agent: Pick<Agent, "subscribe">;
	readonly sessionId: () => string;
	/** Shows (text) or clears (undefined) the waiting line. */
	status(text: string | undefined): void;
}

/** The one resume a session waits for after a usage limit; arming another replaces it. */
export class ResumeTimer {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private isArmed = false;
	private release: Array<() => void> = [];

	private readonly host: ResumeTimerHost;

	constructor(host: ResumeTimerHost) {
		this.host = host;
	}

	get armed(): boolean {
		return this.isArmed;
	}

	/** Runs `fire` at `at`, unless a run starts or the session ends first; `label` is the waiting line meanwhile. */
	arm(at: number, label: string, fire: () => void): void {
		this.cancel();
		const sessionId = this.host.sessionId();
		this.isArmed = true;
		this.release.push(
			this.host.agent.subscribe((event) => {
				if (event.type === "agent_start") this.cancel();
			}),
			registerSessionResourceCleanup((ended) => {
				if (ended === undefined || ended === sessionId) this.cancel();
			}),
		);
		this.host.status(label);
		const step = () => {
			const left = at - Date.now();
			if (left > 0) {
				this.timer = setTimeout(step, Math.min(left, MAX_TIMER_MS));
				this.timer.unref();
				return;
			}
			this.cancel();
			fire();
		};
		this.timer = setTimeout(step, Math.max(0, Math.min(at - Date.now(), MAX_TIMER_MS)));
		this.timer.unref();
	}

	cancel(): void {
		if (!this.isArmed) return;
		this.isArmed = false;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		for (const release of this.release.splice(0)) release();
		this.host.status(undefined);
	}
}
