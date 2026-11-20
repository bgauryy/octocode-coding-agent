import type { FeatureContext } from "../../core/features/index.ts";
import { BACKLOG_ITEM_ENV, PARENT_SESSION_ENV } from "@octocodeai/octocode-common/env";
import { openBacklog } from "../backlog/context.ts";
import { storeUnavailable } from "./errors.ts";

/**
 * The goal of the backlog item this session works on: the one it holds (`ongoing`, assigned to it), or the item a
 * subagent was delegated. Read through the backlog store, never SQL. Undefined with no active item: a subagent never
 * claims, so one without a delegated item and the parent that issued it has none. A board that cannot be read now
 * (`storeUnavailable`) never blocks recall; any other error propagates.
 */
export function activeItemGoal(
	ctx: Pick<FeatureContext, "cwd" | "sessionManager">,
	options: { isSubagent: boolean; env?: NodeJS.ProcessEnv },
): string | undefined {
	const env = options.env ?? process.env;
	if (options.isSubagent && !(env[BACKLOG_ITEM_ENV] && env[PARENT_SESSION_ENV])) return undefined;
	try {
		const { store, session } = openBacklog(ctx, { isSubagent: options.isSubagent, env });
		const items = options.isSubagent
			? [store.get(env[BACKLOG_ITEM_ENV]!)]
			: store.list({ states: ["ongoing"], assignees: [session] }).items;
		return (
			items
				.map((item) => item?.goal.trim())
				.filter(Boolean)
				.join(" ") || undefined
		);
	} catch (error) {
		if (storeUnavailable(error)) return undefined;
		throw error;
	}
}
