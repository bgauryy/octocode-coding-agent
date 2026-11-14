import type { ProfileEvent, ProfilePhase } from "@octocodeai/octocode-contracts/profiler";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { num, str, type Entry } from "./entries.ts";
import { STALL_ENTRY } from "./stalls.ts";

/** The `label` of a `wait` span between a failed request and the retry that followed it. */
export const RETRY_WAIT_LABEL = "retry";
/** The `label` of a `wait` span from a prompt to the first request it started. */
export const TURN_START_LABEL = "turn start";
/** A turn start shorter than this is not drawn: it is ordinary context assembly. */
const TURN_START_MIN_MS = 250;

type Phases = Partial<Record<ProfilePhase, number>>;

const positive = (phases: Phases): Phases | undefined => {
	const kept = Object.fromEntries(Object.entries(phases).filter(([, value]) => (value ?? 0) >= 1)) as Phases;
	return Object.keys(kept).length > 0 ? kept : undefined;
};

/** A request's phases: time to its first content and the stream after it, when the response recorded them. */
export function requestPhases(message: Record<string, unknown>): Phases | undefined {
	const first = num(message.firstTokenMs);
	const duration = num(message.durationMs);
	if (!first) return undefined;
	return positive({ firstToken: first, stream: Math.max(0, duration - first) });
}

/**
 * A tool result's timing: its execution span and its phases. The result was made `held` after the call ended and
 * `finalize` after its execution, so the execution started `held + finalize + execute` before the result.
 */
export function toolTiming(
	message: Record<string, unknown>,
	resultAt: number,
): { at: number; phases?: Phases; early?: true } {
	const execute = num(message.durationMs);
	const recorded = asRecord(message.phases);
	const held = num(recorded.heldMs);
	const finalize = num(recorded.finalizeMs);
	const phases = positive({
		prepare: num(recorded.prepareMs),
		queued: num(recorded.queuedMs),
		execute,
		finalize,
		held,
	});
	return {
		at: resultAt - held - finalize - execute,
		...(phases && Object.keys(phases).some((key) => key !== "execute") ? { phases } : {}),
		...(recorded.early === true ? { early: true as const } : {}),
	};
}

/**
 * Follows a lane's entries in order and yields the waits that sit between them: from a prompt to the first request it
 * started (`turn start`), and from a failed request to the retry after it (`retry`).
 */
export class LaneWaits {
	private prompt: { at: number; position: number } | undefined;
	private failed: { at: number; position: number } | undefined;

	private readonly agentId: string;

	constructor(agentId: string) {
		this.agentId = agentId;
	}

	/** A prompt (not a steer or follow-up, which arrive while a turn runs). */
	prompted(at: number, position: number): void {
		this.prompt = { at, position };
		this.failed = undefined;
	}

	/** A response that ended in an error; the next request is its retry when nothing else came between. */
	failedAt(at: number, position: number): void {
		this.failed = { at, position };
	}

	/** A response (a request, or a failed attempt) that started at `start`: the waits it closes. */
	requested(start: number): ProfileEvent[] {
		const waits: ProfileEvent[] = [];
		if (this.prompt && start - this.prompt.at >= TURN_START_MIN_MS)
			waits.push(this.wait("turn-start", TURN_START_LABEL, this.prompt.at, start, this.prompt.position));
		else if (this.failed && start > this.failed.at)
			waits.push(this.wait("retry", RETRY_WAIT_LABEL, this.failed.at, start, this.failed.position));
		this.prompt = undefined;
		this.failed = undefined;
		return waits;
	}

	private wait(kind: string, label: string, from: number, to: number, entry: number): ProfileEvent {
		return {
			id: `${this.agentId}:wait:${kind}:${entry}`,
			agentId: this.agentId,
			kind: "wait",
			at: from,
			durationMs: to - from,
			label,
			ref: { entry },
		};
	}
}

/** A stall entry as a timeline event: the window it was found in, labelled with its longest delay and phase. */
export function stallEvent(agentId: string, entry: Entry, position: number): ProfileEvent | undefined {
	if (entry.type !== "custom" || entry.customType !== STALL_ENTRY) return undefined;
	const data = asRecord(entry.data);
	const from = num(data.from);
	const at = num(data.at);
	const maxMs = num(data.maxMs);
	if (!from || !at || !maxMs) return undefined;
	return {
		id: `${agentId}:stall:${entry.id}`,
		agentId,
		kind: "stall",
		at: from,
		durationMs: Math.max(0, at - from),
		label: `event loop blocked ${Math.round(maxMs)}ms during ${str(data.during, "the run").slice(0, 60)}`,
		ref: { entry: position },
	};
}
