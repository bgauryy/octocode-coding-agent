import { formatDuration } from "../../shared/format.ts";
import type { ChildState, WatchdogLimits } from "../events.ts";

/** How far past its cadence a tick may run before the gap counts as the machine sleeping (`team/ticker.ts` does the same). */
const SUSPEND_MARGIN_MS = 15_000;

/** Stops a child stuck on a stalled model stream or a call past its deadline, so a run cannot spin forever. */
export class ChildWatchdog {
	/** When the child last wrote output, or a wait for the user ended. */
	activeAt = Date.now();
	/** Why the watchdog stopped the child, once it has. */
	stalled: Error | undefined;

	private tickedAt = this.activeAt;
	private timer: NodeJS.Timeout | undefined;
	private readonly state: Pick<ChildState, "toolsRunning" | "settling" | "busyUntil" | "lastActivity">;
	private readonly limits: WatchdogLimits;
	private readonly paused: () => boolean;
	private readonly onStall: () => void;

	constructor(
		state: Pick<ChildState, "toolsRunning" | "settling" | "busyUntil" | "lastActivity">,
		limits: WatchdogLimits,
		paused: () => boolean,
		onStall: () => void,
	) {
		this.state = state;
		this.limits = limits;
		this.paused = paused;
		this.onStall = onStall;
	}

	private get intervalMs(): number {
		return Math.max(250, Math.min(30_000, this.limits.idleMs / 4));
	}

	start(): void {
		this.timer = setInterval(() => this.tick(Date.now()), this.intervalMs);
		this.timer.unref();
	}

	stop(): void {
		clearInterval(this.timer);
	}

	/** Time spent waiting for the user does not count against the child's deadlines. */
	waited(ms: number, now: number): void {
		this.state.busyUntil += ms;
		this.activeAt = now;
	}

	tick(now: number): void {
		const gap = now - this.tickedAt;
		this.tickedAt = now;
		// A timer cannot fire while the machine sleeps: a gap is time the child could not run either, not a hang. Its deadlines
		// move by the gap, or a closed lid would kill every busy child at the first tick after waking.
		if (gap > this.intervalMs + SUSPEND_MARGIN_MS) {
			this.activeAt += gap;
			this.state.busyUntil += gap;
			return;
		}
		if (this.stalled || this.paused()) return;
		const { state, limits } = this;
		const busy = state.toolsRunning > 0 || state.settling;
		if (busy ? now < state.busyUntil : now - this.activeAt < limits.idleMs) return;
		const silent = formatDuration(now - this.activeAt);
		this.stalled = new Error(
			busy
				? `Subagent stopped: ${state.lastActivity} ran past its own deadline; last output ${silent} ago. Its process tree was killed.`
				: `Subagent stopped: no output for ${silent}; last activity: ${state.lastActivity}, ${silent} ago. Its process tree was killed.`,
		);
		this.onStall();
	}
}
