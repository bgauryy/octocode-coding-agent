import { VALID_THINKING_LEVELS } from "../../core/thinking-level.ts";

/** The `:<level>` suffixes Octocode's `--model <pattern>` accepts. */
export const THINKING_LEVELS: ReadonlySet<string> = new Set(VALID_THINKING_LEVELS);

/** The `:<level>` suffix a model value or purpose ends with (`:low`), or "" without one. */
export function thinkingSuffix(value: string | undefined): string {
	const colon = value ? value.lastIndexOf(":") : -1;
	return value && colon > 0 && THINKING_LEVELS.has(value.slice(colon + 1)) ? value.slice(colon) : "";
}

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

/** A route's `:thinking` level (`low` in `p/m:low`), or undefined without one. */
export const routeThinking = (model: string | undefined): string | undefined =>
	thinkingSuffix(model).slice(1) || undefined;

/** The route with its level replaced by `level`. */
export const withThinking = (model: string, level: string): string =>
	`${model.slice(0, model.length - thinkingSuffix(model).length)}:${level}`;
