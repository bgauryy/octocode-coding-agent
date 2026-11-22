import type { PayloadEvent, Topic } from "../topics.ts";

/**
 * The topics whose delivery the event loop owns (RFC agent-event-loop §6, §14 R6–R10). A cut-over is one line here: a
 * topic in this table is delivered by the loop when `runtime.eventLoop` is `new`, and by the wake gate in every other mode.
 * Never both: the gate routes an emit of such a topic to the loop (`wake/gate.ts`, `GateRoute`) instead of sending it.
 *
 * - `live`: held in memory for the session; the producer's own record (a job's row and log) is the durable one.
 * - `durable`: written to the event log with what a restarted session needs to send it again (`live-host.ts` keeps the
 *   message), and queued again after a restart or resume until the loop has delivered it.
 * - `once`: durable, and a second event with the same catalog key in the session is the same event (a report or a mail the
 *   producer sent twice), so it is not delivered twice. A topic whose key repeats legitimately is not `once`.
 *
 * Add a topic only together with its producers' tests in `new` mode and its entry in the RFC's cut-over list.
 */
const CUT_OVER: Readonly<Partial<Record<Topic, "live" | "durable" | "once">>> = {
	// R6: a bash job's exit, own or joined.
	"job.exit": "live",
	// R7: a child's report, the end of a child (a `wait on agent.ended` firing), and team mail.
	"agent.report": "once",
	"agent.ended": "durable",
	"agent.message": "once",
	// R8: a timer's fire (the same timer and run is one fire), the `notify` conditions a restarted session still owes its model
	// (these repeat legitimately, so not `once`), and the backlog feed (the audit row's id names the event).
	"time.due": "once",
	"check.result": "durable",
	"item.state": "durable",
	"item.changed": "durable",
	"path.unlocked": "durable",
	"peer.landed": "durable",
	"item.peer": "once",
	// R10: a background hook's feedback that restarts a session (live: the hook's own process is the only record).
	"hook.feedback": "live",
	// RM2: a callback ticket's result (a ticket settles once, so its key never repeats).
	"ticket.resolved": "once",
	"ticket.rejected": "once",
};

/** Whether the loop delivers events of this one's topic. */
export const isCutOver = (event: PayloadEvent): boolean => CUT_OVER[event.kind] !== undefined;

/** Whether an event of this one's topic is written with its message and queued again after a restart. */
export const isDurable = (event: PayloadEvent): boolean => {
	const how = CUT_OVER[event.kind];
	return how === "durable" || how === "once";
};

/** Whether the event's catalog key names it for the session: a repeat is dropped. */
export const isDeduped = (event: PayloadEvent): boolean => CUT_OVER[event.kind] === "once";
