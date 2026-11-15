import { performance } from "node:perf_hooks";
import { FENCE_PROBE, FENCE_REPLY } from "../tui/latency-fence.ts";

/** A probe this old is lost: the latency fence gives up on it after the same time. */
const LOST_AFTER_MS = 2_000;

/**
 * Latency probes (`CSI 5 n`) written but not yet answered. A reply that arrives after the TUI stopped reading would be
 * typed into the shell, so the exit drain waits for these. A terminal that never answers is not waited on past
 * `LOST_AFTER_MS`.
 */
export class StatusProbeWatch {
	private readonly sentAt: number[] = [];

	noteWrite(data: string, now = performance.now()): void {
		// Forget probes long lost, so the list stays short on a terminal that never answers.
		while (this.sentAt.length > 0 && now - (this.sentAt[0] ?? now) >= 2 * LOST_AFTER_MS) this.sentAt.shift();
		for (let at = data.indexOf(FENCE_PROBE); at !== -1; at = data.indexOf(FENCE_PROBE, at + 1)) this.sentAt.push(now);
	}

	noteInput(sequence: string): void {
		if (sequence === FENCE_REPLY) this.sentAt.shift();
	}

	awaiting(now = performance.now()): boolean {
		return this.sentAt.some((at) => now - at < LOST_AFTER_MS);
	}
}

/**
 * Wait until input has been quiet for `idleMs` and no probe awaits a reply. `maxMs` ends a wait on input that keeps
 * arriving; a pending reply extends it until its probe counts as lost, because a lagging terminal answers late.
 */
export async function waitForQuietInput(options: {
	maxMs: number;
	idleMs: number;
	lastDataAt: () => number;
	watch: StatusProbeWatch;
}): Promise<void> {
	const { maxMs, idleMs, lastDataAt, watch } = options;
	const endTime = Date.now() + maxMs;
	while (true) {
		const now = Date.now();
		const timeLeft = endTime - now;
		const awaiting = watch.awaiting();
		if (!awaiting && (timeLeft <= 0 || now - lastDataAt() >= idleMs)) return;
		await new Promise((resolve) => setTimeout(resolve, timeLeft > 0 ? Math.min(idleMs, timeLeft) : idleMs));
	}
}
