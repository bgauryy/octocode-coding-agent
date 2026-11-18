import { THINKING_LEVELS } from "../render/route-thinking.ts";

/** Thinking level of a child whose call and profile name none. */
export const SUBAGENT_THINKING_ENV = "OCTOCODE_SUBAGENT_THINKING";

/**
 * A child's level when neither its call nor its profile names one. Never the parent's: the coordinator thinks hard and
 * a worker spends only what its task needs, so the user's `defaultThinkingLevel` (the coordinator's) does not reach it.
 */
export const SUBAGENT_DEFAULT_THINKING = "medium";

/** The level `OCTOCODE_SUBAGENT_THINKING` names, else `SUBAGENT_DEFAULT_THINKING` (a value that is not a level is ignored). */
export function subagentThinking(env: NodeJS.ProcessEnv = process.env): string {
	const value = env[SUBAGENT_THINKING_ENV]?.trim().toLowerCase();
	return value && THINKING_LEVELS.has(value) ? value : SUBAGENT_DEFAULT_THINKING;
}
