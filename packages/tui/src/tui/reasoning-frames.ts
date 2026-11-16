import { animationClock } from "../tokens/clock.ts";
import { MOTION } from "../tokens/design.ts";

/** An offscreen reasoning label stops requesting decorative frames after two seconds. */
export class ReasoningFrames {
	private unsubscribe: (() => void) | undefined;
	private readonly label: () => { renderedAt: number } | undefined;
	private readonly requestRender: (() => void) | undefined;

	constructor(label: () => { renderedAt: number } | undefined, requestRender: (() => void) | undefined) {
		this.label = label;
		this.requestRender = requestRender;
	}

	sync(): void {
		if (!this.label() || !this.requestRender) return this.stop();
		if (this.unsubscribe) return;
		this.unsubscribe = animationClock.subscribe(
			(now) => {
				const label = this.label();
				if (label && now - label.renderedAt < 2_000) this.requestRender?.();
				else this.stop();
			},
			{ everyMs: MOTION.spinnerMs, kind: "decor" },
		);
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}
