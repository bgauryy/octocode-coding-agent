import type { Source } from "../source-types.ts";
import type { PayloadEvent, Topic } from "../topics.ts";

/**
 * How soon an entry is delivered: the one field every message through the loop carries. It is decided in code from what
 * the entry is (`EventCatalog.priority`), never by the sender's delivery options and never by the model.
 *
 * - `regular` (the default): the next task. It joins the queue behind what is already there and is delivered at the next
 *   step boundary of a run in progress, or after the window when the session is idle. Nothing running is cut.
 * - `urgent`: it interrupts. The loop stops the step in progress (`LoopOptions.interrupt`) and the entry is delivered,
 *   ahead of every regular one, as soon as the run has stopped; an idle session takes it at once, without the window.
 */
export type Priority = "regular" | "urgent";

/**
 * Where an entry waits. Q1 is user input. Q2 is what a run in progress takes at its next step boundary. Q3 is what an idle
 * session takes after the window; a run that starts moves it to Q2. A stop or cancel is never queued (`EventLoop.preempt`).
 */
export type QueueId = "Q1" | "Q2" | "Q3";

/** What the loop needs to know about a topic; the wake catalog answers it, and the host hands it in. */
export interface EventCatalog {
	/** The digest line and the coalescing key of an event. */
	describe(event: PayloadEvent): { label: string; key: string };
	/** Whether an event of this topic asks for a turn by default. */
	wakes(topic: Topic): boolean;
	/** How soon the event is delivered, from the event itself. */
	priority(event: PayloadEvent): Priority;
}

/** A background event for the session. `carry` is the sender's own message, handed back untouched at delivery. */
export interface EventEntry<C = undefined> {
	type: "event";
	event: PayloadEvent;
	source: Source;
	/** Asks for a turn: false means the line only rides along with the next one. */
	wake: boolean;
	/** How soon it is delivered (`EventCatalog.priority` of its event). */
	priority: Priority;
	/** An event whose dedupe key the log already holds is dropped. */
	dedupeKey?: string;
	/** Stored with the event so a restarted loop can rebuild `carry` (`EventLoop.replay`). */
	body?: Record<string, unknown>;
	carry: C;
}

/** Text the user typed or sent (terminal, ACP prompt, web). */
export interface InputEntry<C = undefined> {
	type: "input";
	text: string;
	carry: C;
	/** Who typed or sent it (`userSource`); its trust says whether it carries the user's authority. */
	source: Source;
}

export type Entry<C = undefined> = EventEntry<C> | InputEntry<C>;

/** An entry after the log gave it its place. User text is not logged: its `seq` is 0. `arrival` orders every entry, logged or not. */
export type Logged<C = undefined> = Entry<C> & { seq: number; queue: QueueId; arrival: number };

/**
 * Where in a run a batch is handed over: `idle` (nothing runs; a wake or typed input), `boundary` (between steps of a run,
 * joins it), `settle` (the run would stop), `drain` (the compaction lock was released).
 */
export type DeliveryPoint = "idle" | "boundary" | "settle" | "drain";

/** One line of a batch: an event, or the events that share its coalescing key (`count` of them). */
export interface BatchLine {
	topic: string;
	key: string;
	digest: string;
	source: Source;
	count: number;
	seqs: number[];
}

/** Everything delivered together: one message, one turn at most. */
export interface Batch<C = undefined> {
	/** Every entry the batch consumes, user input first, then arrival order. Duplicates are here; the lines count them. */
	entries: Array<Logged<C>>;
	/** The lines the message shows, at most the cap; events past it are `more`. */
	lines: BatchLine[];
	/** Events left out of `lines` by the cap, readable in the log between `range`. */
	more: number;
	range?: { from: number; to: number };
	/** Some entry asked for a turn. */
	trigger: boolean;
}

/** The longest message: more lines read as a wall of text, so the rest is a count and a log range. */
export const MAX_BATCH_LINES = 20;
