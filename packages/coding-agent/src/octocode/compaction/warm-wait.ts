import type { FeatureContext } from "../../core/features/index.ts";
import type { RunningWork } from "../shared/running-work.ts";

/** Whether the session waits for an answer it asked for; the composer supplies it (`awaits-answer.ts`). */
export type AwaitsAnswer = (ctx: Pick<FeatureContext, "sessionManager">) => boolean;

/**
 * Whether an idle session waits on something known to resume it, so its next request comes without a person and a
 * cache refresh now is likely read: background subagents, bash jobs or external work still run, a timer is armed
 * (`work`), or it waits for an answer it asked for (`awaitsAnswer`).
 */
export function expectsWake(
	work: Pick<RunningWork, "busy" | "all">,
	ctx: Pick<FeatureContext, "sessionManager">,
	awaitsAnswer: AwaitsAnswer,
): boolean {
	return work.busy() > 0 || work.all().length > 0 || awaitsAnswer(ctx);
}
