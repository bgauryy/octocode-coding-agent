import type { Source } from "../source-types.ts";
import type { PayloadEvent } from "../topics.ts";
import { EventLoop } from "./loop.ts";
import { RunSignals, type SessionSignals } from "./signals.ts";
import { MemoryEventStore } from "./store.ts";
import type { Batch, DeliveryPoint, EventCatalog } from "./types.ts";

/**
 * Shadow mode (`runtime.eventLoop: "shadow"`): the event loop sees every send the wake gate sees and every run signal, makes
 * its own delivery decisions, and acts on nothing. When the session ends, its decisions are compared with what the gate
 * did, and each difference is reported. The comparison is about what reaches the model, not when: the gate delivers at
 * once and the loop after its window, so a wake the loop merges into an earlier batch is counted, not reported.
 */

/** What the wake gate tells its observer about one `emit`; `ticket` names it afterwards. */
export interface GateObserver {
	emitted(events: readonly PayloadEvent[], sources: readonly Source[], wakes: boolean, steer: boolean): number;
	/** The gate handed the emit's message to the session; `triggered` is whether that send asked for a turn. */
	sent(ticket: number, triggered: boolean): void;
}

type ShadowDiffKind =
	/** The gate woke the session for an event the loop never delivered with a turn. */
	| "wake-lost"
	/** The loop delivered events in another order than the gate sent them. */
	| "order"
	/** A run ended with nothing pending in the session, but the loop would have continued it. */
	| "phantom-continue";

export interface ShadowDiff {
	kind: ShadowDiffKind;
	detail: string;
}

export interface ShadowStats {
	emits: number;
	/** Gate sends that asked for a turn. */
	gateTurns: number;
	/** Batches the loop delivered with a turn. */
	loopTurns: number;
}

interface Ticket {
	label: string;
	wakes: boolean;
	/** Undefined until the gate sent it. */
	gateTriggered?: boolean;
	gateOrder?: number;
	loopTriggered?: boolean;
	loopOrder?: number;
}

export interface ShadowOptions {
	catalog: EventCatalog;
	/** Receives a failure of the loop itself (a delivery that threw); the shadow carries on without that delivery. */
	failed: (error: unknown) => void;
	/** The loop's window in ms (`runtime.eventWindowSeconds`), read at each wake. */
	windowMs: () => number;
	/** Receives each difference once, when the session ends. */
	report: (diff: ShadowDiff) => void;
}

export class ShadowLoop implements GateObserver, SessionSignals {
	private readonly loop: EventLoop<number>;
	private readonly signals: RunSignals;
	private readonly tickets: Ticket[] = [];
	private readonly found: ShadowDiff[] = [];
	private gateOrder = 0;
	private loopOrder = 0;
	private loopTurns = 0;
	private gateTurns = 0;
	private ended = false;
	private readonly options: ShadowOptions;

	constructor(options: ShadowOptions) {
		this.options = options;
		this.loop = new EventLoop<number>({
			store: new MemoryEventStore(),
			catalog: options.catalog,
			windowMs: options.windowMs,
			deliver: (batch, point) => this.decided(batch, point),
			onError: options.failed,
		});
		this.signals = new RunSignals(this.loop);
	}

	emitted(events: readonly PayloadEvent[], sources: readonly Source[], wakes: boolean, steer: boolean): number {
		const ticket = this.tickets.push({ label: events.map((event) => event.kind).join("+"), wakes }) - 1;
		events.forEach((event, index) => {
			const source = sources[index] ?? sources[0];
			if (source) this.loop.publish({ event, source, wake: wakes, steer, carry: ticket });
		});
		return ticket;
	}

	sent(ticket: number, triggered: boolean): void {
		const entry = this.tickets[ticket];
		if (!entry) return;
		entry.gateTriggered = triggered;
		entry.gateOrder = ++this.gateOrder;
		if (triggered) this.gateTurns++;
	}

	/** A run segment starts: the session woke, which is the moment the loop's window would have ended. */
	runStarted(): void {
		this.loop.flushNow();
		this.loop.signal("run_start");
	}

	/** A step of the run ended; `final`: it was a reply with no tool calls, where the run would stop (`RunSignals`). */
	stepEnded(final: boolean): void {
		this.signals.stepEnded(final);
	}

	/** A turn began. */
	turnStarted(): void {
		this.signals.turnStarted();
	}

	/** The run settled; `continues` is whether the session still holds a message to run next (it ends otherwise). */
	settled(continues: boolean): void {
		const wouldContinue = this.signals.settled(continues);
		if (wouldContinue && !continues)
			this.found.push({ kind: "phantom-continue", detail: "the loop held a wake the session never received" });
	}

	compactionStarted(): void {
		this.loop.lock();
	}

	compactionEnded(): void {
		this.loop.unlock();
	}

	stats(): ShadowStats {
		return { emits: this.tickets.length, gateTurns: this.gateTurns, loopTurns: this.loopTurns };
	}

	/** The session ends: delivers what the window still holds, compares, reports each difference once, and stops the timer. */
	end(): ShadowDiff[] {
		if (this.ended) return [];
		this.ended = true;
		this.loop.flushNow();
		this.loop.dispose();
		this.compare();
		for (const diff of this.found) this.options.report(diff);
		return this.found;
	}

	private decided(batch: Batch<number>, _point: DeliveryPoint): void {
		if (batch.trigger) this.loopTurns++;
		for (const entry of batch.entries) {
			const ticket = entry.type === "event" ? this.tickets[entry.carry] : undefined;
			if (!ticket || ticket.loopOrder !== undefined) continue;
			ticket.loopOrder = ++this.loopOrder;
			ticket.loopTriggered = batch.trigger;
		}
	}

	private compare(): void {
		// A session that ends mid-run or mid-compaction leaves events queued on purpose; only a finished picture is compared.
		const settled = this.loop.state === "idle";
		const sentByGate = this.tickets.filter((ticket) => ticket.gateOrder !== undefined);
		for (const ticket of sentByGate) {
			if (ticket.wakes && ticket.gateTriggered && !ticket.loopTriggered && settled)
				this.found.push({ kind: "wake-lost", detail: ticket.label });
		}
		const both = sentByGate.filter((ticket) => ticket.loopOrder !== undefined);
		const byLoop = [...both].sort((a, b) => (a.loopOrder ?? 0) - (b.loopOrder ?? 0));
		const byGate = [...both].sort((a, b) => (a.gateOrder ?? 0) - (b.gateOrder ?? 0));
		const at = byLoop.findIndex((ticket, index) => ticket !== byGate[index]);
		if (at >= 0) this.found.push({ kind: "order", detail: `${byLoop[at]?.label} before ${byGate[at]?.label}` });
	}
}
