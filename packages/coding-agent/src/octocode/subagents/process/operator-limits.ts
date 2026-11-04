import {
	envFlag,
	OPERATOR_EXCLUDE_TOOLS_ENV,
	OPERATOR_NO_MCP_ENV,
	SUBAGENT_ENV,
} from "../../../../../common/src/env.ts";

/** What the operator of the run took away on its command line, which binds every process below that run. */
interface OperatorLimits {
	excludeTools: readonly string[];
	noMcp: boolean;
}

export function operatorLimits(env: NodeJS.ProcessEnv = process.env): OperatorLimits {
	const excluded = env[OPERATOR_EXCLUDE_TOOLS_ENV];
	return { excludeTools: excluded ? excluded.split(",") : [], noMcp: env[OPERATOR_NO_MCP_ENV] === "1" };
}

/**
 * Notes a top-level run's `--exclude-tools` and `--no-mcp` where its children inherit them. A subagent records nothing: its
 * own flags are what its parent composed, a profile's excludes and a lean child's `--no-mcp` among them, and those belong to
 * that child alone. A session a child's shell started keeps what it inherited and adds its own, so it only gets stricter.
 */
export function recordOperatorLimits(
	flags: { excludeTools?: readonly string[]; noMcp?: boolean },
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (envFlag(env, SUBAGENT_ENV)) return;
	const excluded = new Set([...operatorLimits(env).excludeTools, ...(flags.excludeTools ?? [])]);
	if (excluded.size > 0) env[OPERATOR_EXCLUDE_TOOLS_ENV] = [...excluded].join(",");
	if (flags.noMcp) env[OPERATOR_NO_MCP_ENV] = "1";
}
