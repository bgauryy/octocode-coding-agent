import { WAKE_TYPE } from "../../core/wake-entry.ts";
export { WAKE_TYPE } from "../../core/wake-entry.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureSetup } from "../../core/features/index.ts";
import { sessionPhaseOf, type SessionPhaseStore } from "../shared/session-phase.ts";
import { sourceOfEvent, withSource } from "../events/source.ts";
import type { Source } from "../events/source-types.ts";
import type { PayloadEvent as AgentEvent } from "../events/topics.ts";
import { isCutOver } from "../events/loop/cutover.ts";
import type { GateObserver } from "../events/loop/shadow.ts";
import { recordProblem } from "../../core/diagnostics-log.ts";
import { PendingRows } from "./pending-rows.ts";
import { Routed } from "./routed.ts";
import {
	itemKey,
	type GateRoute,
	type Held,
	type Message,
	type Pending,
	type SendOptions,
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
 * The one path a wake source sends through. It keeps the source's message, delivery options and receipts as they are and adds
 * three things: what each run wrote (so a nudge about that item can be dropped), one visible row per woken batch, and an
 * optional hold that merges wakes arriving seconds apart into one turn. The hold applies only while no run is in progress:
 * a steer or interrupt a busy run takes (including the mail that continues a headless subagent as its run settles) is
 * never delayed.
 */
export class WakeGate {
	private readonly api: GateApi;
	private holdMs: () => number;
	private busy = false;
	private inRun = false;
	/** Between `agent_settled` and `agent_settle_end`: sends made now are deferred until the settle ends. */
	private settling = false;
	/** Items the current (or just ended) run wrote with its tool calls. */
	private wrote = new Set<string>();
	/** Wake events since the last run segment started, one line per event key. */
	private readonly rows: PendingRows;
	/** Calls of tools that write items, by call id, until the tool ends. */
	private readonly calls = new Map<string, string[]>();
	private held: Held[] = [];
	private timer: NodeJS.Timeout | undefined;
	private dropped = 0;
	/** The wakes sent whose turn has not begun, for the session's phase (`shared/session-phase.ts`). */
	private readonly sent = new Set<Sent>();
	private readonly phase: SessionPhaseStore;
	/** Shadow mode's view of every send (`events/loop/shadow.ts`); it never changes what is sent. */
	private observer: GateObserver | undefined;
	/** Sends the live loop holds, until it delivers them: they count as wakes for the session's phase like a held send. */
	private readonly routed = new Routed();
	/** Sees every emit before it is sent or routed (`onEmit`); a listener never changes what is sent. */
	private readonly emitListeners = new Set<(events: readonly AgentEvent[], sources: readonly Source[]) => void>();

	constructor(api: GateApi, options: { holdMs?: () => number; now?: () => number } = {}) {
		this.api = api;
		this.phase = sessionPhaseOf(api);
		this.holdMs = options.holdMs ?? (() => 0);
		this.rows = new PendingRows(options.now ?? Date.now);
	}

	/** Attaches the observer that sees each emit and its send; `undefined` detaches it. */
	setObserver(observer: GateObserver | undefined): void {
		this.observer = observer;
	}

	/** Attaches the live loop that delivers cut-over topics instead of this gate; `undefined` returns them to the gate. */
	setRoute(route: GateRoute | undefined): void {
		this.routed.set(route);
	}

	/** Sets where the hold window comes from (the setting, read at each wake). */
	setHold(holdMs: () => number): void {
		this.holdMs = holdMs;
	}

	/** Calls `listener` with the events and sources of every emit, before it is sent; returns the way to stop. */
	onEmit(listener: (events: readonly AgentEvent[], sources: readonly Source[]) => void): () => void {
		this.emitListeners.add(listener);
		return () => void this.emitListeners.delete(listener);
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
		message: Message,
		options: SendOptions = {},
		wakes = options.triggerTurn === true,
		sources?: readonly Source[],
	): void | Promise<void> {
		const eventList = Array.isArray(events) ? events : [events];
		const sourceList = sources ?? eventList.map(sourceOfEvent);
		for (const listener of this.emitListeners) listener(eventList, sourceList);
		const sourced = withSource(message, sourceList);
		if (this.routed.active && wakes && eventList.length > 0 && eventList.every(isCutOver))
			return this.routeToLoop(eventList, sourceList, sourced, options);
		const ticket = this.observer?.emitted(eventList, sourceList, wakes, options.deliverAs === "steer");
		// A steer that joins the run in progress starts no new run, so it has no row.
		const listed =
			wakes && !(this.busy && options.deliverAs === "steer")
				? (Array.isArray(events) ? events : [events]).map((event) => this.rows.record(event))
				: [];
		const hold = wakes && !this.busy && this.held.length === 0 ? this.holdMs() : 0;
		const labels = listed.map((line) => line.label);
		let sending: void | Promise<void>;
		let direct = false;
		try {
			direct = hold <= 0 && this.held.length === 0;
			sending = direct
				? this.api.session.sendMessage(sourced, options)
				: this.hold(sourced, options, hold, labels, ticket);
			if (direct && ticket !== undefined) this.observer?.sent(ticket, options.triggerTurn === true);
		} catch (error) {
			this.rows.unlist(listed);
			throw error;
		}
		if (isPromise(sending)) sending.then(undefined, () => this.rows.unlist(listed));
		if (direct) this.track(labels, sending);
		return sending;
	}

	/**
	 * A wake of a cut-over topic: the loop decides when and with what it is sent (`sendRouted`). The row line and the phase's
	 * wake are the gate's, as for a held send. The receipt settles once the loop has the event (as a send settles once the
	 * session queues it, mid-run or behind a compaction); a later failed send is recorded as a problem, since no one awaits it.
	 */
	private routeToLoop(
		events: readonly AgentEvent[],
		sources: readonly Source[],
		message: Message,
		options: SendOptions,
	): Promise<void> {
		const { held, listed } = this.heldFor(events, message, options);
		try {
			const taken = this.routed.take(held, events, sources, options.deliverAs === "steer");
			this.publish();
			if (!taken) this.rows.unlist(listed);
			return Promise.resolve();
		} catch (error) {
			this.publish();
			this.rows.unlist(listed);
			return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)));
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

	/**
	 * The live loop delivers a batch: each send in order, only the last starting a turn, and only when `wake`. `ending`: the
	 * session is going away, so none starts a turn.
	 */
	sendRouted(batch: readonly Held[], wake: boolean, ending: boolean): void {
		this.routed.release(batch);
		this.sendAll(batch, wake && !ending, ending);
	}

	/** Queues a send for the end of the hold window (which the first held wake opens); later sends keep their order behind it. */
	private hold(
		message: Message,
		options: SendOptions,
		ms: number,
		labels: string[],
		ticket: number | undefined,
	): Promise<void> {
		const sent = new Promise<void>((resolve, reject) =>
			this.held.push({
				labels,
				message,
				options,
				...(ticket === undefined ? {} : { ticket }),
				done: { resolve, reject },
			}),
		);
		this.publish();
		// A caller that ignores the result must not leave an unhandled rejection; one that awaits it still sees it.
		sent.catch(() => undefined);
		if (!this.timer) {
			this.timer = setTimeout(() => this.release(), ms);
			this.timer.unref?.();
		}
		return sent;
	}

	/** Sends everything held, in order; only the last send starts the turn, and only when some held send wanted one. */
	release(): void {
		this.flush(false);
	}

	/** `ending`: the session is going away, so no send may start a turn in it, and a send that fails is reported on stderr once. */
	private flush(ending: boolean): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		const batch = this.held;
		this.held = [];
		this.sendAll(batch, !ending && batch.some((each) => each.options.triggerTurn === true), ending);
	}

	private sendAll(batch: readonly Held[], wake: boolean, ending: boolean): void {
		const labels = wake ? batch.flatMap((each) => each.labels) : [];
		let reported = false;
		const failed = (each: Held, error: unknown) => {
			if (ending && !reported) {
				reported = true;
				process.stderr.write(`octocode: a held wake message was not sent at session end: ${errorMessage(error)}\n`);
			}
			each.done.reject(error);
		};
		batch.forEach((each, index) => {
			const options = { ...each.options, triggerTurn: wake && index === batch.length - 1 };
			try {
				const sending = this.api.session.sendMessage(each.message, options);
				if (each.ticket !== undefined) this.observer?.sent(each.ticket, wake);
				if (index === batch.length - 1) this.track(labels, sending);
				if (isPromise(sending)) sending.then(each.done.resolve, (error: unknown) => failed(each, error));
				else each.done.resolve();
			} catch (error) {
				failed(each, error);
			}
		});
		this.publish();
	}

	/** Publishes the wakes held for the window and those sent whose turn has not begun. */
	private publish(): void {
		this.phase.setWakes("gate", [
			...this.held.flatMap((each) => each.labels),
			...this.routed.labels(),
			...[...this.sent].flatMap((each) => each.labels),
		]);
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
			this.wrote = new Set();
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
		if (refs.length > 0) this.calls.set(callId, [...refs]);
	}

	/** The tool ended; a call that did not fail counts as the run writing those items. */
	toolEnded(callId: string, failed: boolean): void {
		const refs = this.calls.get(callId);
		this.calls.delete(callId);
		if (failed || !refs) return;
		for (const ref of refs) {
			const key = itemKey(ref);
			if (key) this.wrote.add(key);
		}
	}

	/**
	 * Whether the last run wrote `ref` (a note, completion, claim, close, step, or a delegation to it): it decided about the
	 * item, so a nudge about it would only make the model repeat itself. Being woken about an item is not acting on it.
	 */
	actedOn(ref: string): boolean {
		const key = itemKey(ref);
		return key !== undefined && this.wrote.has(key);
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

	/**
	 * Session end: what is held is sent at once without starting a turn (the session is being torn down, and a timer would not
	 * fire); a send that fails rejects for its owner's recovery to deliver again, and is reported on stderr once.
	 */
	dispose(): void {
		if (this.held.length > 0) this.flush(true);
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
