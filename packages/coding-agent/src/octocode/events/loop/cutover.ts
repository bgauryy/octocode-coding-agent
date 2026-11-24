import type { PayloadEvent, Topic } from "../topics.ts";

/** Persistence policy for model wakes. Every wake uses the same dispatcher. Topics absent from the table
 * need only the session queue. A live entry records the event, a durable entry also saves its delivery
 * envelope, and a once entry additionally rejects duplicate producer IDs. */
const PERSISTENCE: Readonly<Partial<Record<Topic, "live" | "durable" | "once">>> = {
	// A completed task, including an owned or joined bash job, has one report.
	"job.exit": "once",
	// R7: a child's report, the end of a child (a `wait on agent.ended` firing), and team mail.
	"agent.report": "once",
	"agent.ended": "durable",
	"agent.message": "once",
	// R8: a timer's fire (the same timer and run is one fire), the `notify` conditions a restarted session still owes its model
	// (these repeat legitimately, so not `once`), and the backlog feed (the audit row's id names the event).
	"time.due": "once",
	"check.result": "durable",
	"item.peer": "once",
	// R10: a background hook's feedback that restarts a session (live: the hook's own process is the only record).
	"hook.feedback": "live",
	// RM2: a callback ticket's result (a ticket settles once, so its key never repeats).
	"ticket.resolved": "once",
	"ticket.rejected": "once",
};

/** Whether the dispatcher also writes this event to its session log. */
export const recordsEvent = (event: PayloadEvent): boolean => PERSISTENCE[event.kind] !== undefined;

/** Whether an event of this one's topic is written with its message and queued again after a restart. */
export const isDurable = (event: PayloadEvent): boolean => {
	const how = PERSISTENCE[event.kind];
	return how === "durable" || how === "once";
};

/** Whether the event's catalog key names it for the session: a repeat is dropped. */
export const isDeduped = (event: PayloadEvent): boolean => PERSISTENCE[event.kind] === "once";
