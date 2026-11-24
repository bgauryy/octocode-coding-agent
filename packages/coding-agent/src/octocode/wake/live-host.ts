import { DeliveryReceipts } from "./delivery-receipts.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureSetup } from "../../core/features/index.ts";
import { recordProblem } from "../../core/diagnostics-log.ts";
import { LiveLoop } from "../events/loop/live.ts";
import type { EventStore } from "../events/loop/store.ts";
import type { GateRoute, Held, WakeGate } from "./gate.ts";
import { durableOf, replayOf, type SessionOf, sessionStore } from "./live-durable.ts";
import { installLiveInput } from "./live-input.ts";
import { wakeCatalog } from "./loop-catalog.ts";
import { bindSessionSignals, eventWindowMs } from "./session-signals.ts";

export interface LiveHostOptions {
	/** Receives the loop's own failure; the default is the problem log. */
	failed?: (error: unknown) => void;
	/** Receives the handle once, so a host or test can read the running loop. */
	attached?: (handle: LiveHandle) => void;
	/** Where a session's events and offset live; default the event log of the shared database. */
	store?: (ctx: SessionOf) => EventStore | Promise<EventStore>;
}

export interface LiveHandle {
	/** The session loop while attached. */
	loop(): LiveLoop<Held> | undefined;
}

/** Attach one scheduler to the session. The gate hands each wake to it and sends the resulting batch with its receipts.
 * A generation prevents a delayed registration or delivery from entering a replacement session. */
export function installLive(api: FeatureSetup, gate: WakeGate, options: LiveHostOptions = {}): LiveHandle {
	const failed = options.failed ?? ((error: unknown) => void recordProblem("event-loop", errorMessage(error)));
	let live: LiveLoop<Held> | undefined;
	let generation = 0;
	let destination = 0;
	const superseded = new Error("Event delivery superseded by a session change");
	let opening: Promise<unknown> | undefined;
	let currentStore: EventStore | undefined;
	const detach = (): LiveLoop<Held> | undefined => {
		const was = live;
		live = undefined;
		gate.setRoute(undefined);
		return was;
	};
	const fail = (error: unknown): void => {
		// What the loop still holds goes out as it would at the session's end, so no sender waits on it.
		void detach()?.end();
		failed(error);
	};
	api.bus.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const owner = ++generation;
		detach()?.discard();
		if (destination !== 0) gate.dispose();
		destination = owner;
		const store = (options.store ?? sessionStore)(ctx);
		const attach = (log: EventStore) => {
			if (generation !== owner) return undefined;
			const receipts = new DeliveryReceipts(log, (id) => ctx.sessionManager.getEntry(id), failed);
			currentStore = receipts;
			const loop = new LiveLoop<Held>({
				catalog: wakeCatalog,
				store: receipts,
				windowMs: () => eventWindowMs(api),
				send: (batch, point, mayWake, ending) =>
					gate.sendRouted(batch, {
						sending: (seq, held) => receipts.sending(seq, held),
						assertOwner: () => {
							if (owner !== destination) throw superseded;
						},
						// A queued steer already pays for the next request. Attach these completions to that boundary.
						mayWake: () => mayWake() && !(point === "boundary" && ctx.hasPendingMessages()),
						ending,
					}),
				failed: (error) => {
					if (error === superseded) return;
					if (generation === owner && live === loop) fail(error);
					else failed(error);
				},
				// An urgent entry stops the step in progress; `peer` leaves the user's own queued input where it is.
				interrupt: () => ctx.abort("peer"),
			});
			live = loop;
			const route: GateRoute = ({ events, sources, priority, held }) => {
				const result = loop.take({
					event: events[0],
					source: sources[0],
					wake: true,
					priority,
					carry: held,
					...durableOf(events, held, sessionId),
				});
				return result instanceof Promise ? result.then((entry) => entry.accepted) : result.accepted;
			};
			return { receipts, loop, route };
		};
		const connecting = Promise.resolve(store).then(attach);
		opening = connecting;
		// Keep the receipt with the session that requested it while registration waits for a peer writer.
		gate.setRoute((entry) =>
			connecting.then((session) => {
				if (!session || live !== session.loop) throw new Error("Session ended before the event loop opened");
				return session.route(entry);
			}),
		);
		let session: ReturnType<typeof attach>;
		try {
			session = await connecting;
		} catch (error) {
			if (generation === owner) {
				opening = undefined;
				detach();
			}
			throw error;
		}
		if (!session || generation !== owner) return;
		opening = undefined;
		const { receipts, loop, route } = session;
		gate.setRoute(route);
		// What an earlier run of this session left undelivered goes out again, once.
		await loop.replay(
			(_event, stored) => {
				const { events, message, options: sendOptions } = replayOf(stored);
				const held = gate.replayed(events, message, sendOptions);
				held.entryId = receipts.idOf(stored);
				return held;
			},
			(event) => receipts.unrecorded(event),
		);
	});
	installLiveInput(api, () => live);
	bindSessionSignals(api, (call) => {
		const loop = live;
		if (!loop) return;
		try {
			return call(loop);
		} catch (error) {
			fail(error);
		}
	});
	// The end releases the route first: the loop's last batch is sent by the gate, and an emit after it goes the gate's way.
	api.bus.on("session_shutdown", async () => {
		generation++;
		const drained = detach()?.end();
		const initializing = opening;
		const store = currentStore;
		opening = undefined;
		currentStore = undefined;
		// The startup handler reports registration failures; shutdown only joins its outstanding operation.
		if (initializing)
			await initializing.then(
				() => undefined,
				() => undefined,
			);
		await drained;
		await store?.settled?.();
	});
	const handle: LiveHandle = { loop: () => live };
	options.attached?.(handle);
	return handle;
}
