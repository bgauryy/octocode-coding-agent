import type { Batch } from "../events/loop/types.ts";
import { WAKE_TYPE } from "../../core/wake-entry.ts";
export { WAKE_TYPE } from "../../core/wake-entry.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureSetup } from "../../core/features/index.ts";
import { sessionPhaseOf, type SessionPhaseStore } from "../shared/session-phase.ts";
import { sourceOfEvent, withSource } from "../events/source.ts";
import type { Source } from "../events/source-types.ts";
import type { PayloadEvent as AgentEvent } from "../events/topics.ts";
import { recordProblem } from "../../core/diagnostics-log.ts";
import { priorityOfEvents } from "./loop-catalog.ts";
import { asRegular, type HeldSend, Interrupts } from "./interrupts.ts";
import { PendingRows } from "./pending-rows.ts";
import { RunWrites } from "./run-writes.ts";
import { type RoutedHost, sendRouted } from "./send-routed.ts";
import { firstWakeLabel, Routed } from "./routed.ts";
import {
	itemKey,
	type GateRoute,
	type Held,
	type Message,
	type Pending,
	type SendOptions,
	type SessionStop,
	type Sent,
} from "./gate-types.ts";
export type { GateRoute, Held } from "./gate-types.ts";

/** What the gate needs of the host; a source that only sends (team mail) has no `appendEntry`, and then no row is drawn. */
type GateApi = {
	readonly session: Pick<FeatureSetup["session"], "sendMessage"> &
		Partial<Pick<FeatureSetup["session"], "appendEntry">>;
};

export { itemKey };

const isPromise = (value: unknown): value is Promise<void> =>
	typeof (value as { then?: unknown } | undefined)?.then === "function";

/**
 * The one path a wake source sends through. A wake goes to the session's event loop, which decides when it is delivered
 * from its coded priority (`loop-catalog.ts`): no source chooses between steering and following up. The gate keeps the
 * source's message and receipt, and adds what each run wrote (so a nudge about that item can be dropped) and one visible
 * row per woken batch. Without a loop (before the session starts, after it ends, or after the loop failed) a send goes
 * straight to the session.
 */
export class WakeGate {
	private readonly api: GateApi;
	private busy = false;
	private inRun = false;
	/** Between `agent_settled` and `agent_settle_end`: sends made now are deferred until the settle ends. */
	private settling = false;
	private readonly writes = new RunWrites();
	/** Wake events since the last run segment started, one line per event key. */
	private readonly rows: PendingRows;
	private dropped = 0;
	/** The wakes sent whose turn has not begun, for the session's phase (`shared/session-phase.ts`). */
	private readonly sent = new Set<Sent>();
	private readonly phase: SessionPhaseStore;
	/** Sends the event loop holds, until it delivers them: they count as wakes for the session's phase. */
	private readonly routed = new Routed();
	/** Sees every emit before it is sent or routed (`onEmit`); a listener never changes what is sent. */
	private readonly emitListeners = new Set<(events: readonly AgentEvent[], sources: readonly Source[]) => void>();
	/** The stop an urgent send asks for, and the sends held until the stopped run settles. */
	private readonly interrupts = new Interrupts();

	constructor(api: GateApi, options: { now?: () => number } = {}) {
		this.api = api;
		this.phase = sessionPhaseOf(api);
		this.rows = new PendingRows(options.now ?? Date.now);
	}

	/** Attaches the event loop that delivers wakes; `undefined` sends them straight to the session. */
	setRoute(route: GateRoute | undefined): void {
		this.routed.set(route);
		if (!route) this.publish();
	}

	/** Calls `listener` with the events and sources of every emit, before it is sent; returns the way to stop. */
	onEmit(listener: (events: readonly AgentEvent[], sources: readonly Source[]) => void): () => void {
		this.emitListeners.add(listener);
		return () => void this.emitListeners.delete(listener);
	}

	/** The session an urgent send stops; `Mail` binds the one it delivers for. */
	bindSession(session: SessionStop): void {
		this.interrupts.bind(session);
	}

	/** Signalled while an urgent send waits for the run to stop and settle (a wait at the end of the run ends early). */
	get interrupted(): AbortSignal {
		return this.interrupts.signal;
	}

	/**
	 * The run settled: the urgent sends it held go out now, the last one starting the next turn. False when nothing was held
	 * or a send was refused (it and those behind it stay held for the next try).
	 */
	releaseHeld(): boolean {
		return this.interrupts.release((send, stopped, last) => {
			const sending = this.deliver(
				asRegular(send.events),
				send.sources,
				send.message,
				{
					...send.options,
					triggerTurn: last && send.options.triggerTurn,
				},
				true,
				stopped,
			);
			if (isPromise(sending)) sending.then(send.done.resolve, send.done.reject);
			else send.done.resolve();
		});
	}

	/** The session's urgent sends are forgotten (it left): they were never sent. */
	forgetHeld(): void {
		this.interrupts.clear();
	}

	/**
	 * Sends `message` like `api.session.sendMessage`. A message that wakes the session (`wakes`: its own turn trigger by default, or
	 * the batch's when only the batch's last send triggers) is also listed in the next woken batch's row; an event whose key
	 * the batch already lists is listed once, and a send that fails takes its line back. Returns what `sendMessage` returns;
	 * a held send resolves or rejects when it is finally sent. Every message goes out under the header of its source
	 * (`events/source.ts`): `sources` when the sender knows them better than the topic does (verified mail), else each event's.
	 */
	emit(
		events: AgentEvent | readonly AgentEvent[],
		message: Message | ((stopped: boolean) => Message),
		options: SendOptions = {},
		wakes = options.triggerTurn === true,
		sources?: readonly Source[],
	): void | Promise<void> {
		const eventList = Array.isArray(events) ? events : [events];
		const sourceList = sources ?? eventList.map(sourceOfEvent);
		for (const listener of this.emitListeners) listener(eventList, sourceList);
		// An urgent wake stops the run of a busy session. With a loop attached the loop makes the stop; without one the
		// gate stops it and holds the send until the run settles (`releaseHeld`). `message` says whether a step was stopped.
		if (wakes && eventList.length > 0 && priorityOfEvents(eventList) === "urgent" && this.interrupts.busy()) {
			const running = this.interrupts.running();
			if (this.routed.active) this.interrupts.markWaiting();
			else if (this.interrupts.stop()) {
				return new Promise<void>((resolve, reject) => {
					const send: HeldSend = {
						events: eventList,
						sources: sourceList,
						message,
						options,
						done: { resolve, reject },
					};
					this.interrupts.hold(send, running);
				});
			}
			return this.deliver(eventList, sourceList, message, options, wakes, running);
		}
		return this.deliver(eventList, sourceList, message, options, wakes, false);
	}

	/** The send itself: to the loop when one is attached and the message wakes, else straight to the session. */
	private deliver(
		eventList: readonly AgentEvent[],
		sourceList: readonly Source[],
		message: Message | ((stopped: boolean) => Message),
		options: SendOptions,
		wakes: boolean,
		stopped: boolean,
	): void | Promise<void> {
		const sourced = withSource(typeof message === "function" ? message(stopped) : message, sourceList);
		if (this.routed.active && wakes && eventList.length > 0)
			return this.routeToLoop(eventList, sourceList, sourced, options);
		// No loop is attached (before the session starts, after it ends, or after the loop failed), or the message asks for
		// no turn: it goes straight to the session. A message that joins the run in progress starts no new run, so no row.
		const listed = wakes && !this.busy ? eventList.map((event) => this.rows.record(event)) : [];
		const labels = listed.map((line) => line.label);
		let sending: void | Promise<void>;
		try {
			sending = this.api.session.sendMessage(sourced, options);
		} catch (error) {
			this.rows.unlist(listed);
			throw error;
		}
		if (isPromise(sending)) sending.then(undefined, () => this.rows.unlist(listed));
		this.track(labels, sending);
		return sending;
	}

	/**
	 * A wake: the loop decides when and with what it is sent (`sendRouted`), from the priority of its events. The row line and the phase's
	 * wake are the gate's, as for a held send. The receipt settles once the loop has the event (as a send settles once the
	 * session queues it, mid-run or behind a compaction); a later failed send is recorded as a problem, since no one awaits it.
	 */
	private async routeToLoop(
		events: readonly AgentEvent[],
		sources: readonly Source[],
		message: Message,
		options: SendOptions,
	): Promise<void> {
		const { held, listed } = this.heldFor(events, message, options);
		try {
			const taken = this.routed.take(held, events, sources, priorityOfEvents(events));
			this.publish();
			if (!(await taken)) {
				this.rows.unlist(listed);
				this.publish();
			}
		} catch (error) {
			this.publish();
			this.rows.unlist(listed);
			throw error instanceof Error ? error : new Error(errorMessage(error));
		}
	}

	/** The send of a cut-over wake: its row line, and a failed send recorded as a problem (no one awaits it). */
	private heldFor(
		events: readonly AgentEvent[],
		message: Message,
		options: SendOptions,
	): { held: Held; listed: Pending[] } {
		const listed = events.map((event) => this.rows.record(event));
		const lost = (error: unknown) => {
			this.rows.unlist(listed);
			recordProblem("event-loop", `a ${events[0].kind} was not delivered: ${errorMessage(error)}`);
		};
		return {
			listed,
			held: {
				labels: listed.map((line) => line.label),
				message,
				options,
				done: { resolve: () => undefined, reject: lost },
			},
		};
	}

	/** A cut-over wake a restarted session finds undelivered: it is held for the loop again, as when it was emitted. */
	replayed(events: readonly AgentEvent[], message: Message, options: SendOptions): Held {
		const { held } = this.heldFor(events, message, options);
		this.routed.adopt(held);
		this.publish();
		return held;
	}

	/** Hands one batch to the transcript (`send-routed.ts`). */
	sendRouted(batch: Batch<Held>, host: RoutedHost): void | Promise<void> {
		return sendRouted(batch, host, {
			send: (message, options) => this.api.session.sendMessage(message, options),
			release: (held) => this.routed.release(held),
			track: (labels, sending) => this.track(labels, sending),
			publish: () => this.publish(),
		});
	}

	/** Publishes the wakes the loop holds and those sent whose turn has not begun. */
	private publish(): void {
		const label = this.routed.firstLabel() ?? firstWakeLabel(this.sent);
		this.phase.setWakes("gate", label === undefined ? [] : [label]);
	}

	/**
	 * A wake was sent: it counts until a run starts (`segmentStarted`) or its send is rejected. A send that settled without a
	 * run stops counting at once while the session is idle, since nothing will start it; during a run or its settle, when
	 * that settle ends (`settleEnded`).
	 */
	private track(labels: string[], sending: void | Promise<void>): void {
		if (labels.length === 0) return;
		const entry: Sent = { labels, answered: false };
		this.sent.add(entry);
		this.publish();
		const end = () => {
			if (this.sent.delete(entry)) this.publish();
		};
		const answered = () => {
			if (!this.sent.has(entry)) return;
			if (this.busy || this.settling) entry.answered = true;
			else end();
		};
		if (isPromise(sending)) sending.then(answered, end);
		else answered();
	}

	/** Forgets the sent wakes: a run began, so what they started has begun. */
	private landed(): void {
		if (this.sent.size === 0) return;
		this.sent.clear();
		this.publish();
	}

	/** A run segment starts: it opens a run (resetting what the last one did) and gets the row for the wakes behind it. */
	segmentStarted(showRow: boolean): void {
		this.busy = true;
		this.landed();
		if (!this.inRun) {
			this.inRun = true;
			this.writes.reset();
		}
		const lines = this.rows.take();
		if (showRow && lines.length > 0) this.api.session.appendEntry?.(WAKE_TYPE, { events: lines });
	}

	/** The run settled; `continues` is true while a queued message starts its next segment. What it did stays readable until the next run. */
	settled(continues: boolean): void {
		this.busy = continues;
		this.inRun = continues;
		this.settling = true;
	}

	/**
	 * The settle ended (`agent_settle_end`): the sends it deferred have run, and a run they started has begun. A settled send
	 * still listed started nothing, so it stops counting; while a run continues, its own settle decides.
	 */
	settleEnded(): void {
		this.settling = false;
		if (this.busy) return;
		let changed = false;
		for (const entry of this.sent) if (entry.answered && this.sent.delete(entry)) changed = true;
		if (changed) this.publish();
	}

	/** A tool that writes items starts: its call id and the item refs it names. */
	toolStarted(callId: string, refs: readonly string[]): void {
		this.writes.started(callId, refs);
	}

	/** The tool ended; a call that did not fail counts as the run writing those items. */
	toolEnded(callId: string, failed: boolean): void {
		this.writes.ended(callId, failed);
	}

	/**
	 * Whether the last run wrote `ref` (a note, completion, claim, close, step, or a delegation to it): it decided about the
	 * item, so a nudge about it would only make the model repeat itself. Being woken about an item is not acting on it.
	 */
	actedOn(ref: string): boolean {
		return this.writes.has(ref);
	}

	/** Counts a nudge that was not sent. */
	drop(count = 1): void {
		this.dropped += count;
	}

	/** The nudges dropped since the last acknowledgement. Reading does not change it. */
	droppedCount(): number {
		return this.dropped;
	}

	/** The announcer of `count` dropped nudges (from `droppedCount`) took them; nudges dropped since stay counted. */
	ackDropped(count: number): void {
		this.dropped = Math.max(0, this.dropped - count);
	}

	/** Releases the outgoing session’s indicators. The loop still owns its durable handoff. */
	dispose(): void {
		this.rows.clear();
		this.writes.clear();
		this.dropped = 0;
		this.busy = false;
		this.inRun = false;
		this.settling = false;
		this.interrupts.clear();
		this.landed();
	}
}

const gates = new WeakMap<object, WakeGate>();

/** The session's gate. Created on first use with no hold, so a source works without `registerWake`. */
export function wakeGateOf(api: GateApi): WakeGate {
	let gate = gates.get(api);
	if (!gate) {
		gate = new WakeGate(api);
		gates.set(api, gate);
	}
	return gate;
}
