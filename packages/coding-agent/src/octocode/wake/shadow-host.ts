import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureSetup } from "../../core/features/index.ts";
import { recordProblem } from "../../core/diagnostics-log.ts";
import { type ShadowDiff, ShadowLoop } from "../events/loop/shadow.ts";
import type { WakeGate } from "./gate.ts";
import { wakeCatalog } from "./loop-catalog.ts";
import { bindSessionSignals, eventLoopMode, eventWindowMs } from "./session-signals.ts";

/** Where a shadow difference goes by default: the problem log, which `/status` shows. */
const reportShadowDiff = (diff: ShadowDiff): void => {
	recordProblem("event-loop", `shadow: ${diff.kind}: ${diff.detail}`);
};

export interface ShadowHostOptions {
	report?: (diff: ShadowDiff) => void;
	/** Receives the loop's own failure; the default is the problem log. */
	failed?: (error: unknown) => void;
	/** Receives the handle once, so a host or test can read the running shadow loop. */
	attached?: (handle: ShadowHandle) => void;
}

export interface ShadowHandle {
	/** The running shadow loop; undefined unless `runtime.eventLoop` is `shadow`, or after the loop failed and was detached. */
	loop(): ShadowLoop | undefined;
}

/**
 * Runs the event loop beside the wake gate (RFC agent-event-loop R4, shadow mode). The gate stays the only thing that sends;
 * the loop sees the same sends and run signals and its decisions are compared when the session ends. The setting is read
 * at `session_start` (settings are not readable while features register); in any mode but `shadow` nothing is
 * attached and each handler returns at once. The loop must never disturb the session: when it fails once it is detached,
 * the failure is reported, and the gate carries on alone. `loop()` is the running shadow, for tests.
 */
export function installShadow(api: FeatureSetup, gate: WakeGate, options: ShadowHostOptions = {}): ShadowHandle {
	const failed = options.failed ?? ((error: unknown) => void recordProblem("event-loop", errorMessage(error)));
	let shadow: ShadowLoop | undefined;
	// Every call into the loop goes through here: one failure detaches it and the session never sees the throw.
	const detach = (error: unknown): void => {
		shadow = undefined;
		gate.setObserver(undefined);
		failed(error);
	};
	const run = (call: (loop: ShadowLoop) => void): void => {
		if (!shadow) return;
		try {
			call(shadow);
		} catch (error) {
			detach(error);
		}
	};
	const observed = <A extends unknown[], R>(call: (loop: ShadowLoop, ...args: A) => R, fallback: R) => {
		return (...args: A): R => {
			let result = fallback;
			run((loop) => void (result = call(loop, ...args)));
			return result;
		};
	};
	api.bus.on("session_start", async () => {
		if (eventLoopMode(api) !== "shadow") return;
		shadow = new ShadowLoop({
			catalog: wakeCatalog,
			windowMs: () => eventWindowMs(api),
			report: options.report ?? reportShadowDiff,
			failed: detach,
		});
		gate.setObserver({
			emitted: observed((loop, events, sources, wakes, steer) => loop.emitted(events, sources, wakes, steer), -1),
			sent: observed((loop, ticket: number, triggered: boolean) => loop.sent(ticket, triggered), undefined),
		});
	});
	bindSessionSignals(api, run);
	const handle: ShadowHandle = { loop: () => shadow };
	options.attached?.(handle);
	return handle;
}
