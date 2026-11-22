import os from "node:os";
import { envInt } from "@octocodeai/octocode-common/env";

export const MAX_SUBAGENTS_ENV = "OCTOCODE_MAX_SUBAGENTS";
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
export function maxSubagents(env: NodeJS.ProcessEnv = process.env, fallback: number = thisMachineSubagents()): number {
	const value = envInt(env, MAX_SUBAGENTS_ENV, fallback);
	return value >= 1 ? value : fallback;
}
