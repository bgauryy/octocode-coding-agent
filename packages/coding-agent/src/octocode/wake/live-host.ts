import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureSetup } from "../../core/features/index.ts";
import { recordProblem } from "../../core/diagnostics-log.ts";
import { LiveLoop } from "../events/loop/live.ts";
import type { EventStore } from "../events/loop/store.ts";
import type { Held, WakeGate } from "./gate.ts";
import { durableOf, replayOf, type SessionOf, sessionStore } from "./live-durable.ts";
import { installLiveInput } from "./live-input.ts";
import { wakeCatalog } from "./loop-catalog.ts";
import { bindSessionSignals, eventLoopMode, eventWindowMs } from "./session-signals.ts";

export interface LiveHostOptions {
	/** Receives the loop's own failure; the default is the problem log. */
	failed?: (error: unknown) => void;
	/** Receives the handle once, so a host or test can read the running loop. */
	attached?: (handle: LiveHandle) => void;
	/** Where a session's events and offset live; default the event log of the shared database. */
	store?: (ctx: SessionOf) => EventStore;
}

export interface LiveHandle {
	/** The running live loop; undefined unless `runtime.eventLoop` is `new`, or after the session ended or the loop failed. */
	loop(): LiveLoop<Held> | undefined;
}

/**
 * Runs the event loop as the deliverer of the cut-over topics (`events/loop/cutover.ts`) when `runtime.eventLoop` is `new`
 * (RFC agent-event-loop §14 R6): the gate hands such an emit to the loop (`gate.setRoute`), the loop decides when and in what
 * batch, and the gate sends each message with its sender's own receipt. The setting is read at `session_start`; in any other
 * mode nothing is attached and each handler returns at once. When the loop fails or the session ends the route is removed,
 * so a later emit goes the gate's way and is never left waiting.
 */
export function installLive(api: FeatureSetup, gate: WakeGate, options: LiveHostOptions = {}): LiveHandle {
	const failed = options.failed ?? ((error: unknown) => void recordProblem("event-loop", errorMessage(error)));
	let live: LiveLoop<Held> | undefined;
	const detach = (): LiveLoop<Held> | undefined => {
		const was = live;
		live = undefined;
		gate.setRoute(undefined);
		return was;
	};
	const fail = (error: unknown): void => {
		// What the loop still holds goes out as it would at the session's end, so no sender waits on it.
		detach()?.end();
		failed(error);
	};
	api.bus.on("session_start", async (_event, ctx) => {
		if (eventLoopMode(api) !== "new") return;
		const sessionId = ctx.sessionManager.getSessionId();
		const loop = new LiveLoop<Held>({
			catalog: wakeCatalog,
			store: (options.store ?? sessionStore)(ctx),
			windowMs: () => eventWindowMs(api),
			send: (batch, _point, ending) =>
				gate.sendRouted(
					batch.entries.flatMap((entry) => (entry.type === "event" ? [entry.carry] : [])),
					// Typed input starts its own turn through the session; the events it released do not start another.
					batch.trigger && !batch.entries.some((entry) => entry.type === "input"),
					ending,
				),
			failed: fail,
		});
		live = loop;
		gate.setRoute(
			({ events, sources, steer, held }) =>
				loop.take({
					event: events[0],
					source: sources[0],
					wake: true,
					steer,
					carry: held,
					...durableOf(events, held, sessionId),
				}).accepted,
		);
		// What an earlier run of this session left undelivered goes out again, once.
		loop.replay((_event, stored) => {
			const { events, message, options: sendOptions } = replayOf(stored);
			return gate.replayed(events, message, sendOptions);
		});
	});
	installLiveInput(api, () => live);
	bindSessionSignals(api, (call) => {
		const loop = live;
		if (!loop) return;
		try {
			call(loop);
		} catch (error) {
			fail(error);
		}
	});
	// The end releases the route first: the loop's last batch is sent by the gate, and an emit after it goes the gate's way.
	api.bus.on("session_shutdown", async () => void detach());
	const handle: LiveHandle = { loop: () => live };
	options.attached?.(handle);
	return handle;
}
