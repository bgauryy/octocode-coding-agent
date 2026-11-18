import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureSetup } from "../../core/features/index.ts";
import { sessionPhaseOf, type SessionPhaseStore } from "../shared/session-phase.ts";
import { type AgentEvent, describeEvent } from "./catalog.ts";

/** What the gate needs of the host; a source that only sends (team mail) has no `appendEntry`, and then no row is drawn. */
type GateApi = {
	readonly session: Pick<FeatureSetup["session"], "sendMessage"> &
		Partial<Pick<FeatureSetup["session"], "appendEntry">>;
};
type Message = Parameters<FeatureSetup["session"]["sendMessage"]>[0];
type SendOptions = NonNullable<Parameters<FeatureSetup["session"]["sendMessage"]>[1]>;

/** The session entry (never sent to the model) that shows one batch of wake events as a single row. */
export const WAKE_TYPE = "octocode-wake";

/** Wake events remembered for the next row; older ones are dropped, as are events a run never started for. */
const MAX_PENDING = 12;
const PENDING_MAX_AGE_MS = 60_000;

/** One event as the row lists it. */
export interface WakeLine {
	kind: string;
	label: string;
}

/** An event waiting for the next row, with its dedupe key and how many sends still stand behind it. */
interface Pending extends WakeLine {
	key: string;
	at: number;
	sends: number;
}

/**
 * A wake sent and not yet taken up by a run: its labels, and whether its send has settled. A send made while a run is in
 * progress or settling resolves before the turn it asks for can start (the host queues it, or defers it until the
 * `agent_settled` handlers return), so a settled send counts until a run starts or the settle ends (`agent_settle_end`).
 */
interface Sent {
	labels: string[];
	answered: boolean;
}

interface Held {
	labels: string[];
	message: Message;
	options: SendOptions;
	done: { resolve: () => void; reject: (error: unknown) => void };
}

/** `B12`, `b12`, `#12` → `B12`; anything else is not an item reference. */
export function itemKey(ref: string | undefined): string | undefined {
	const seq = ref === undefined ? undefined : /^\s*(?:[bB]|#)?(\d{1,9})\s*$/.exec(ref)?.[1];
	return seq === undefined ? undefined : `B${Number(seq)}`;
}

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
	private readonly now: () => number;
	private busy = false;
	private inRun = false;
	/** Between `agent_settled` and `agent_settle_end`: sends made now are deferred until the settle ends. */
	private settling = false;
	/** Items the current (or just ended) run wrote with its tool calls. */
	private wrote = new Set<string>();
	/** Wake events since the last run segment started, one line per event key. */
	private pending: Pending[] = [];
	/** Calls of tools that write items, by call id, until the tool ends. */
	private readonly calls = new Map<string, string[]>();
	private held: Held[] = [];
	private timer: NodeJS.Timeout | undefined;
	private dropped = 0;
	/** The wakes sent whose turn has not begun, for the session's phase (`shared/session-phase.ts`). */
	private readonly sent = new Set<Sent>();
	private readonly phase: SessionPhaseStore;

	constructor(api: GateApi, options: { holdMs?: () => number; now?: () => number } = {}) {
		this.api = api;
		this.phase = sessionPhaseOf(api);
		this.holdMs = options.holdMs ?? (() => 0);
		this.now = options.now ?? Date.now;
	}

	/** Sets where the hold window comes from (the setting, read at each wake). */
	setHold(holdMs: () => number): void {
		this.holdMs = holdMs;
	}

	/**
	 * Sends `message` like `api.session.sendMessage`. A message that wakes the session (`wakes`: its own turn trigger by default, or
	 * the batch's when only the batch's last send triggers) is also listed in the next woken batch's row; an event whose key
	 * the batch already lists is listed once, and a send that fails takes its line back. Returns what `sendMessage` returns;
	 * a held send resolves or rejects when it is finally sent.
	 */
	emit(
		events: AgentEvent | readonly AgentEvent[],
		message: Message,
		options: SendOptions = {},
		wakes = options.triggerTurn === true,
	): void | Promise<void> {
		// A steer that joins the run in progress starts no new run, so it has no row.
		const listed =
			wakes && !(this.busy && options.deliverAs === "steer")
				? (Array.isArray(events) ? events : [events]).map((event) => this.record(event))
				: [];
		const hold = wakes && !this.busy && this.held.length === 0 ? this.holdMs() : 0;
		const labels = listed.map((line) => line.label);
		let sending: void | Promise<void>;
		let direct = false;
		try {
			direct = hold <= 0 && this.held.length === 0;
			sending = direct ? this.api.session.sendMessage(message, options) : this.hold(message, options, hold, labels);
		} catch (error) {
			this.unlist(listed);
			throw error;
		}
		if (isPromise(sending)) sending.then(undefined, () => this.unlist(listed));
		if (direct) this.track(labels, sending);
		return sending;
	}

	private record(event: AgentEvent): Pending {
		const { label, key } = describeEvent(event);
		const same = this.pending.find((line) => line.key === key);
		if (same) {
			same.sends++;
			return same;
		}
		const line = { kind: event.kind, label, key, at: this.now(), sends: 1 };
		this.pending.push(line);
		if (this.pending.length > MAX_PENDING) this.pending.shift();
		return line;
	}

	/** A send failed: its events no longer wake anything, so the next run is not shown as woken by them. */
	private unlist(lines: readonly Pending[]): void {
		for (const line of lines) if (--line.sends <= 0) this.pending = this.pending.filter((each) => each !== line);
	}

	/** Queues a send for the end of the hold window (which the first held wake opens); later sends keep their order behind it. */
	private hold(message: Message, options: SendOptions, ms: number, labels: string[]): Promise<void> {
		const sent = new Promise<void>((resolve, reject) =>
			this.held.push({ labels, message, options, done: { resolve, reject } }),
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
		const wake = !ending && batch.some((each) => each.options.triggerTurn === true);
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
		const cutoff = this.now() - PENDING_MAX_AGE_MS;
		const lines = this.pending.filter((line) => line.at >= cutoff).map(({ kind, label }) => ({ kind, label }));
		this.pending = [];
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
