import { READ_ONLY_ENV, SUBAGENT_ENV, envFlag } from "@octocodeai/octocode-common/env";
import { optionalString } from "../shared/util.ts";

/** The one operation of each backlog tool that only reads: `backlog get` (an item by id) and `backlogPlan list` (find items). */
const READS = new Map([
	["backlog", "get"],
	["backlogPlan", "list"],
]);

/** Whether this process is a read-only subagent (reviewer, researcher): it reads the board and never writes it. */
export const readOnlyChild = (env: NodeJS.ProcessEnv): boolean =>
	envFlag(env, SUBAGENT_ENV) && envFlag(env, READ_ONLY_ENV);

/** The operation a read-only role may not run on a backlog tool, or undefined for a read or another tool. */
export function backlogRoleWrite(toolName: string, input: Record<string, unknown>): string | undefined {
	const read = READS.get(toolName);
	if (read === undefined) return undefined;
	const op = optionalString(input.op);
	return op === read ? undefined : `${toolName} ${op ?? "without an op"}`;
}
