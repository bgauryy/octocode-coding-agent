/** The time a hook registration reads: how long a hook ran, and when an event's hooks must stop. A test supplies its own. */
export interface HookClock {
	/** The current time in ms; the difference of two readings is a hook's run time. */
	now(): number;
	/** A signal that aborts after `ms`. */
	deadline(ms: number): AbortSignal;
}

export const REAL_HOOK_CLOCK: HookClock = {
	now: () => Date.now(),
	deadline: (ms) => AbortSignal.timeout(ms),
};
