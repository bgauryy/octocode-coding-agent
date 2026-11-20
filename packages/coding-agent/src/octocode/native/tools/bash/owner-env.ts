import {
	AGENT_ID_ENV,
	BACKLOG_ITEM_ENV,
	OWNER_AGENT_ENV,
	OWNER_ITEM_ENV,
	OWNER_JOB_ENV,
} from "@octocodeai/octocode-common/env";
import type { BashToolOptions } from "../../../../core/tools/bash.ts";

/** Who a command runs for: shared resources it takes (the full-run lock) record these names. */
export interface RunOwner {
	agent?: string;
	item?: string;
	job?: string;
}

/**
 * The owner of this session's commands: its team name (a subagent's is its parent's choice, `AGENT_ID_ENV`), the item the
 * call named, else the item a subagent was started for.
 */
export function runOwner(
	teamName: string | undefined,
	item: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): RunOwner {
	const agent = env[AGENT_ID_ENV]?.trim() || teamName;
	const owned = item ?? (env[BACKLOG_ITEM_ENV]?.trim() || undefined);
	return { ...(agent ? { agent } : {}), ...(owned ? { item: owned } : {}) };
}

/** `env` with the owner's names set and any inherited ones removed, so a command never carries another's. */
export function withRunOwner(env: NodeJS.ProcessEnv, owner: RunOwner): NodeJS.ProcessEnv {
	const { [OWNER_AGENT_ENV]: _agent, [OWNER_ITEM_ENV]: _item, [OWNER_JOB_ENV]: _job, ...rest } = env;
	return {
		...rest,
		...(owner.agent ? { [OWNER_AGENT_ENV]: owner.agent } : {}),
		...(owner.item ? { [OWNER_ITEM_ENV]: owner.item } : {}),
		...(owner.job ? { [OWNER_JOB_ENV]: owner.job } : {}),
	};
}

/** The foreground command's environment: the owner without a job (a foreground command is no job until it moves to the background). */
export const ownerSpawnHook =
	(owner: RunOwner): NonNullable<BashToolOptions["spawnHook"]> =>
	(context) => ({ ...context, env: withRunOwner(context.env, owner) });
