import { isRetryableErrorText } from "@octocodeai/octocode-ai";
import { type AssistantMessage, isContextOverflow } from "@octocodeai/octocode-ai/compat";
import type { BoundaryContextPreview, FeatureContext } from "../core/features/index.ts";
import { settleWithin } from "./shared/util.ts";
import type { AgentControl } from "./subagents/tool.ts";

const WAIT_FOR_QUEUE = () => new Promise((resolve) => setImmediate(resolve));

/** What the hold reads of `agent_before_settle`. */
interface FailedRun {
	context: Pick<BoundaryContextPreview, "contextMessages">;
}

/** The failure the run is about to end on, when waiting could clear it: a retryable provider error, not an overflow. */
function retryableFailure(event: FailedRun, ctx: FeatureContext): AssistantMessage | undefined {
	for (const message of [...event.context.contextMessages].reverse()) {
		if (message.role !== "assistant") continue;
		if (message.stopReason !== "error" || !isRetryableErrorText(message.errorMessage ?? "")) return undefined;
		return isContextOverflow(message, ctx.model?.contextWindow ?? 0) ? undefined : message;
	}
	return undefined;
}

/**
 * The failed run of a headless parent (print, JSON). Its children are the work, and a settled run takes them down at
 * shutdown, so one provider outage at any of a long run's turns would end all of it. While children live and the failure
 * can clear, the run holds and tries again when the next report arrives, which is also new work for the model to read.
 * It ends only when none is left and the last attempt failed too, saying how to resume, because the only other trace is
 * the exit code. `held` carries across the attempts of one run.
 */
export async function holdFailedRun(
	event: FailedRun,
	ctx: FeatureContext,
	agents: AgentControl | undefined,
	stop: AbortSignal,
	held: { value: boolean },
	stderr: (text: string) => void = (text) => void process.stderr.write(text),
): Promise<{ continue: true } | undefined> {
	const live = agents?.background() ?? 0;
	if (agents && live > 0 && retryableFailure(event, ctx)) {
		held.value = true;
		stderr(`The model request failed; holding for ${live} running subagents and retrying when the next one reports.\n`);
		await settleWithin(agents.nextReport(), undefined, stop);
		if (stop.aborted) return undefined;
		// A finished run always files a report, and it reaches the queue through an async send. The session refuses the
		// continuation itself if nothing did arrive, which ends the run as this failure.
		await WAIT_FOR_QUEUE();
		return { continue: true };
	}
	if (held.value || live > 0) {
		const id = ctx.sessionManager.getSessionId();
		stderr(
			`The run failed${live > 0 ? `, stopping ${live} running subagents` : " after its subagents finished"}. Session ${id}; continue it with: octocode --resume ${id}\n`,
		);
	}
	return undefined;
}
