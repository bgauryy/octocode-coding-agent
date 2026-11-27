import os from "node:os";
import { envInt } from "@octocodeai/octocode-common/env";

export const MAX_SUBAGENTS_ENV = "OCTOCODE_MAX_SUBAGENTS";
const SUBAGENT_LINGER_ENV = "OCTOCODE_SUBAGENT_LINGER_SECONDS";
const MOST_DEFAULT_SUBAGENTS = 6;
const GIB = 1024 ** 3;

/**
 * The default for a machine: at most 6, one per CPU, and one per GiB of memory (a child and its MCP pair peak near
 * 450 MB, so that stays within about half the machine).
 */
export const machineSubagents = (cores: number, totalMemory: number): number =>
	Math.max(1, Math.min(MOST_DEFAULT_SUBAGENTS, cores, Math.floor(totalMemory / GIB)));

/** Read once: the limit is in a tool description, which must not change during a session. */
let thisMachine: number | undefined;
const thisMachineSubagents = (): number => (thisMachine ??= machineSubagents(os.availableParallelism(), os.totalmem()));

/** How many subagents may run at once: `OCTOCODE_MAX_SUBAGENTS` (a positive integer), else what this machine suits. A call past it waits for a slot. */
export function maxSubagents(env: NodeJS.ProcessEnv, fallback: number = thisMachineSubagents()): number {
	const value = envInt(env, MAX_SUBAGENTS_ENV, fallback);
	return value >= 1 ? value : fallback;
}

/**
 * The swarm's limits, built once when a session starts and passed to what needs them, so a test sets them without the
 * environment. `maxSubagents`: how many run at once; `lingerSeconds`: how long a finished background subagent stays
 * reachable (a message resumes its saved conversation), 0 = off.
 */
export interface SwarmLimits {
	readonly maxSubagents: number;
	readonly lingerSeconds: number;
}

/** The limits `env` sets (`OCTOCODE_MAX_SUBAGENTS`, `OCTOCODE_SUBAGENT_LINGER_SECONDS`), else the defaults. */
export function swarmLimits(env: NodeJS.ProcessEnv, fallback?: number): SwarmLimits {
	return {
		maxSubagents: maxSubagents(env, fallback),
		lingerSeconds: Math.max(0, envInt(env, SUBAGENT_LINGER_ENV, 0)),
	};
}
