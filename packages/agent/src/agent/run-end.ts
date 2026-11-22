import type { Model } from "@octocodeai/octocode-ai";
import { runFailureMessage } from "../agent-loop.ts";
import type { AgentEvent } from "../types.ts";

/** One run of an `Agent`, from its start to idle. */
export type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
	/** The loop already emitted `agent_end`; a later failure must not end the run a second time. */
	ended?: boolean;
	/** Tool calls a failed batch left running, each settled once they all end; awaited (bounded) after the abort. */
	abandoned: Promise<void>[];
	/** The loop threw: what its abandoned calls still emit is refused, as after the run. */
	loopFailed?: boolean;
};

/**
 * How long a failed run waits, after its abort, for the tool calls its loop abandoned to end before it goes idle anyway.
 * A call that honours its signal ends well within it; one that ignores it is left behind rather than holding the agent.
 */
const ABANDONED_TOOLS_GRACE_MS = 2_000;

/** End a run whose loop threw the way a failed run ends: the failure message, `turn_end`, then `agent_end`. */
export async function reportRunFailure(
	model: Pick<Model<any>, "api" | "provider" | "id">,
	error: unknown,
	aborted: boolean,
	emit: (event: AgentEvent) => Promise<void>,
): Promise<void> {
	const failureMessage = runFailureMessage(model, error, aborted);
	await emit({ type: "message_start", message: failureMessage });
	await emit({ type: "message_end", message: failureMessage });
	await emit({ type: "turn_end", message: failureMessage, toolResults: [] });
	await emit({ type: "agent_end", messages: [failureMessage] });
}

/** Wait for abandoned tool calls (promises that never reject) to end, at most `graceMs`; the timer is always cleared. */
export async function settleAbandonedTools(
	abandoned: readonly Promise<void>[],
	graceMs = ABANDONED_TOOLS_GRACE_MS,
): Promise<void> {
	if (abandoned.length === 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.all(abandoned),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, graceMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
