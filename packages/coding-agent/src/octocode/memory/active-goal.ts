import type { FeatureContext } from "../../core/features/index.ts";
import { BACKLOG_ITEM_ENV } from "@octocodeai/octocode-common/env";
import { openBacklog } from "../backlog/context.ts";

/**
 * The goal of the backlog item this session works on: the one it holds (`ongoing`, assigned to it), or the item a
 * subagent was delegated. Read through the backlog store, never SQL. Undefined with no active item; a board that cannot
 * be read never blocks recall.
 */
export function activeItemGoal(
	ctx: Pick<FeatureContext, "cwd" | "sessionManager">,
	options: { isSubagent: boolean; env?: NodeJS.ProcessEnv },
): string | undefined {
	const env = options.env ?? process.env;
	try {
		const { store, session } = openBacklog(ctx, { isSubagent: options.isSubagent, env });
		const delegated = options.isSubagent ? env[BACKLOG_ITEM_ENV] : undefined;
		const items = delegated ? [store.get(delegated)] : store.list({ states: ["ongoing"], assignees: [session] }).items;
		return (
			items
				.map((item) => item?.goal.trim())
				.filter(Boolean)
				.join(" ") || undefined
		);
	} catch {
		return undefined;
	}
}
