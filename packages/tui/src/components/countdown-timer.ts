/**
 * Reusable countdown timer for dialog components.
 */

import { animationClock } from "../tokens/clock.ts";
import { MOTION } from "../tokens/design.ts";
import type { TUI } from "../tui/types.ts";

export class CountdownTimer {
	private unsubscribe: (() => void) | undefined;
	private remainingSeconds: number;
	private readonly deadline: number;
	private tui: TUI | undefined;
	private onTick: (seconds: number) => void;
	private onExpire: () => void;

	constructor(timeoutMs: number, tui: TUI | undefined, onTick: (seconds: number) => void, onExpire: () => void) {
		this.tui = tui;
		this.onTick = onTick;
		this.onExpire = onExpire;
		this.deadline = Date.now() + timeoutMs;
		this.remainingSeconds = Math.ceil(timeoutMs / 1000);
		this.onTick(this.remainingSeconds);

		this.unsubscribe = animationClock.subscribe(
			(now) => {
				// From the deadline, not by counting ticks: the shared clock's ticks are not exactly a second apart.
				const remaining = Math.max(0, Math.ceil((this.deadline - now) / 1000));
				if (remaining === this.remainingSeconds) return;
				this.remainingSeconds = remaining;
				this.onTick(this.remainingSeconds);
				this.tui?.requestRender();

				if (this.remainingSeconds <= 0) {
					this.dispose();
					this.onExpire();
				}
			},
			{ everyMs: MOTION.tickMs, kind: "info" },
		);
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}
