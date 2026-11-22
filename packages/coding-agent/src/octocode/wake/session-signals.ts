import type { FeatureSetup } from "../../core/features/index.ts";
import { RUNTIME_DEFAULTS } from "../../core/settings-schema/runtime.ts";
import type { SessionSignals } from "../events/loop/signals.ts";

/** The `runtime.eventLoop` mode of this session. */
export function eventLoopMode(api: Pick<FeatureSetup, "settings">): "old" | "shadow" | "new" {
	return api.settings.get().runtime?.eventLoop ?? RUNTIME_DEFAULTS.eventLoop;
}

/** The window after a background wake finds the session idle, in ms (`runtime.eventWindowSeconds`), read at each wake. */
export function eventWindowMs(api: Pick<FeatureSetup, "settings">): number {
	const seconds = api.settings.get().runtime?.eventWindowSeconds ?? RUNTIME_DEFAULTS.eventWindowSeconds;
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/**
 * Tells whichever loop `run` reaches what the session does: runs, steps, turns, settles, compaction and the end. The shadow
 * host and the live host bind the same events; `run` is where each guards its loop.
 */
export function bindSessionSignals(api: FeatureSetup, run: (call: (signals: SessionSignals) => void) => void): void {
	api.bus.on("agent_start", async () => run((loop) => loop.runStarted()));
	api.bus.on("turn_end", async (event) => run((loop) => loop.stepEnded(event.toolResults.length === 0)));
	api.bus.on("turn_start", async () => run((loop) => loop.turnStarted()));
	api.bus.on("agent_settled", async (event, ctx) =>
		run((loop) => loop.settled(ctx.hasPendingMessages() && !event.aborted)),
	);
	api.bus.on("session_before_compact", async () => run((loop) => loop.compactionStarted()));
	api.bus.on("session_compact", async () => run((loop) => loop.compactionEnded()));
	// A failed or cancelled compaction gives the lock back too.
	api.bus.on("session_compact_failed", async () => run((loop) => loop.compactionEnded()));
	api.bus.on("session_shutdown", async () => run((loop) => void loop.end()));
}
