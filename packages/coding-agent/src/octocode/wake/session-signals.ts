import type { FeatureSetup } from "../../core/features/index.ts";
import { MAX_EVENT_WINDOW_SECONDS, RUNTIME_DEFAULTS } from "../../core/settings-schema/runtime.ts";
import type { SessionSignals } from "../events/loop/signals.ts";

/** The window after a background wake finds the session idle, in ms (`runtime.eventWindowSeconds`), read at each wake. */
export function eventWindowMs(api: Pick<FeatureSetup, "settings">): number {
	const settings = api.settings.get();
	const seconds =
		settings.runtime?.eventWindowSeconds ?? settings.subagents?.wakeHoldSeconds ?? RUNTIME_DEFAULTS.eventWindowSeconds;
	return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_EVENT_WINDOW_SECONDS) * 1000 : 0;
}

/**
 * Tells the loop `run` reaches what the session does: runs, steps, turns, settles, compaction and the end; `run` is
 * where the host guards its loop.
 */
export function bindSessionSignals(
	api: FeatureSetup,
	run: (call: (signals: SessionSignals) => void | Promise<void>) => void | Promise<void>,
): void {
	api.bus.on("agent_start", async () => run((loop) => loop.runStarted()));
	api.bus.on("turn_end", async (event) => run((loop) => loop.stepEnded(event.toolResults.length === 0)));
	api.bus.on("turn_start", async () => run((loop) => loop.turnStarted()));
	api.bus.on("agent_settled", async (event, ctx) =>
		run((loop) => loop.settled(ctx.hasPendingMessages() && !event.aborted, event.aborted)),
	);
	api.bus.on("session_before_compact", async () => run((loop) => loop.compactionStarted()));
	api.bus.on("session_compact", async () => run((loop) => loop.compactionEnded()));
	// A failed or cancelled compaction gives the lock back too.
	api.bus.on("session_compact_failed", async (event) =>
		run((loop) => loop.compactionEnded(event.aborted && !event.willRetry)),
	);
}
