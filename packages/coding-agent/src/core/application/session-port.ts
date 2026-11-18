/**
 * The session as the application service sees it. Adapters run session operations through `ApplicationPort.invoke`;
 * only the operations listed here are reachable, so a new public session method joins the adapter surface only when it
 * is added to this list. The service itself reads the few session members in `ApplicationSession`.
 */

import type {
	ApplicationOperation,
	ApplicationOperationArgs,
	ApplicationOperationResult,
} from "@octocodeai/octocode-contracts";
import type { AgentSessionApi } from "../agent-session/api.ts";

const APPLICATION_OPERATIONS = [
	"prompt",
	"steer",
	"followUp",
	"sendUserMessage",
	"abort",
	"stopActiveWork",
	"abortRetry",
	"abortCompaction",
	"abortBranchSummary",
	"compact",
	"executeBash",
	"runUserBash",
	"recordBashResult",
	"abortBash",
	"setModel",
	"cycleModel",
	"setScopedModels",
	"setThinkingLevel",
	"cycleThinkingLevel",
	"getContextWindowLimit",
	"setContextWindow",
	"setCacheWarmingMode",
	"setSteeringMode",
	"setFollowUpMode",
	"setQueuedInputMode",
	"clearQueue",
	"holdQueuedInput",
	"releaseQueuedInput",
	"moveQueuedInput",
	"removeQueuedInput",
	"setSessionName",
	"navigateTree",
	"reload",
	"getContextReport",
	"askSideQuestion",
	"getRepositoryDiff",
	"getUntrackedDiff",
	"exportToHtml",
	"exportToJsonl",
	"summarizeForBugReport",
] as const satisfies readonly (keyof AgentSessionApi)[];

const OPERATIONS: ReadonlySet<string> = new Set(APPLICATION_OPERATIONS);

/** The session operations `invoke` runs. */
export type ApplicationOperations = Pick<AgentSessionApi, (typeof APPLICATION_OPERATIONS)[number]>;

/** What the application service reads from its session, besides the operations. */
export type ApplicationSession = ApplicationOperations &
	Pick<
		AgentSessionApi,
		"sessionId" | "messages" | "isStreaming" | "model" | "sessionManager" | "subscribe" | "answerDialog" | "holdDialog"
	> &
	// Optional so a session without tools (a fixture) still projects; its calls then use the generic display.
	Partial<Pick<AgentSessionApi, "getToolRenderers">>;

/** Run a listed operation on the session; any other name, even of a session method, is refused. */
export function invokeOperation<K extends ApplicationOperation<ApplicationOperations>>(
	session: ApplicationOperations,
	operation: K,
	args: ApplicationOperationArgs<ApplicationOperations, K>,
): ApplicationOperationResult<ApplicationOperations, K> {
	if (!OPERATIONS.has(operation)) throw new Error(`${operation} is not an application operation`);
	const method = session[operation] as (
		...parameters: typeof args
	) => ApplicationOperationResult<ApplicationOperations, K>;
	return method.apply(session, args);
}
