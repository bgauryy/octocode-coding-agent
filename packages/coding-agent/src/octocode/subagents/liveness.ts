/** Events that show the model or its tools at work: a request, a streamed reply, a tool call, a compaction. A notify, a dialog or a stdout byte is none. */
export const MODEL_EVENTS: ReadonlySet<string> = new Set([
	"agent_start",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"compaction_start",
	"compaction_progress",
	"compaction_end",
]);

/** After its run settled and its input closed, how long a child has to exit before its process tree is stopped and its report delivered. */
export const SETTLED_EXIT_MS = 10_000;

/** What the reducer knows of a child's declared long work (`ChildState` has these fields). */
interface DeclaredWork {
	toolsRunning: number;
	declaredUntil: number;
	jobsUntil: number;
	/** Pending waits it started (a notify timer, a background job, a reply it asked for). */
	waits: number;
	/** Its answer is in and nothing has started since. */
	settling: boolean;
}

/** A call or background job that declared its own `timeout` is running, so quiet is expected until that deadline. */
export function insideDeclaredWork(state: DeclaredWork, now: number): boolean {
	return (state.toolsRunning > 0 && now < state.declaredUntil) || now < state.jobsUntil;
}

/**
 * Whether the parent should stamp the child's progress without a model event: it works inside declared long work, or
 * waits for the user's answer, or it answered and idles on a wait it started (its own notify, job or reply request) with
 * no tool running, until a job it waits on overruns the deadline its call declared. A model stream or tool hung beside a
 * pending wait is no such idling. Anything else quiet is what `STALL_MS` measures.
 */
export function heartbeatDue(state: DeclaredWork & { running: boolean }, now: number, blockedOnUser: boolean): boolean {
	const jobOverdue = state.jobsUntil > 0 && now >= state.jobsUntil;
	if (state.waits > 0 && state.settling && state.toolsRunning === 0 && !jobOverdue) return true;
	return state.running && (blockedOnUser || insideDeclaredWork(state, now));
}

/** How long a child whose run settled aborted, without this process asking, gets to start the run a team interrupt's message triggers. */
export const INTERRUPT_FOLLOW_UP_MS = 1_500;
