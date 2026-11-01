import type { McpServerEntry } from "../../config.ts";
import { OCTOCODE_SERVER } from "./names.ts";
import { octocodeAllowedPaths } from "./launch.ts";
import { literalConfigValue } from "./literal.ts";
import { warnOnce } from "./warnings.ts";

/**
 * Supply the roots for the configured local Octocode server: the automatic ones, the user's added folders and the
 * process environment's `ALLOWED_PATHS`. An `ALLOWED_PATHS` in the entry's own `env` is the one explicit policy that
 * replaces all of them.
 */
export function prepareOctocodeSkillLaunch(
	entry: McpServerEntry,
	cwd: string,
	skillDirectories: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): McpServerEntry {
	if (entry.name !== OCTOCODE_SERVER || "url" in entry.config) return entry;
	if (entry.config.env?.ALLOWED_PATHS !== undefined) {
		warnOnce(
			`ALLOWED_PATHS in the "${entry.name}" entry of ${entry.source} replaces the workspace, session and skill folders and the allowed folders from settings, .env and .octocoderc: the research tools read only what it lists.`,
		);
		return entry;
	}
	return {
		...entry,
		config: {
			...entry.config,
			env: {
				...(env.WORKSPACE_ROOT === undefined ? { WORKSPACE_ROOT: literalConfigValue(cwd) } : {}),
				...entry.config.env,
				ALLOWED_PATHS: literalConfigValue(octocodeAllowedPaths(cwd, skillDirectories, env)),
			},
		},
	};
}
