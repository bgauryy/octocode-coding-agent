/**
 * The loop's states and the moves between them (RFC agent-event-loop §6, §7). A pure table: the loop owns what each state
 * means for delivery; this file owns which input moves it where. Every state keeps accepting events into the log.
 */

export type LoopState = "idle" | "running" | "nudged" | "stopping" | "locked" | "draining";

/**
 * What happens to the loop: a run starts or ends, the context nears its limit (`nudge`, then `stop` at the next boundary),
 * compaction takes the lock and gives it back (`unlock`), and the queue it held has been delivered (`drained`).
 */
export type LoopInput = "run_start" | "run_end" | "nudge" | "stop" | "lock" | "unlock" | "drained";

export const LOOP_STATES: readonly LoopState[] = ["idle", "running", "nudged", "stopping", "locked", "draining"];
export const LOOP_INPUTS: readonly LoopInput[] = ["run_start", "run_end", "nudge", "stop", "lock", "unlock", "drained"];

/**
 * Each state's moves; a pair not listed leaves the state as it is (a late `run_end` after a lock changes nothing).
 * `stopping` survives its run's end: the hard stop ends the run so compaction can take the lock, and nothing is woken
 * between. `drained` releases a stop that no compaction followed.
 */
const MOVES: Record<LoopState, Partial<Record<LoopInput, LoopState>>> = {
	idle: { run_start: "running", lock: "locked" },
	running: { run_end: "idle", nudge: "nudged", stop: "stopping", lock: "locked" },
	nudged: { run_end: "idle", stop: "stopping", lock: "locked" },
	stopping: { run_start: "running", lock: "locked", drained: "idle" },
	locked: { unlock: "draining" },
	draining: { run_start: "running", lock: "locked", drained: "idle" },
};

export function nextState(state: LoopState, input: LoopInput): LoopState {
	return MOVES[state][input] ?? state;
}

/** A run is in progress: a steer joins it at the next boundary, a follow-up waits for its end. */
export const isBusy = (state: LoopState): boolean => state === "running" || state === "nudged" || state === "stopping";

/** Nothing is delivered: events and typed input are queued. */
export const isLocked = (state: LoopState): boolean => state === "locked";
