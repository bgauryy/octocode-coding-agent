import type { McpServerEntry } from "../../config.ts";
import { OCTOCODE_SERVER } from "./names.ts";
import { octocodeAllowedPaths } from "./launch.ts";

/** Supply default roots only for the configured local Octocode server; explicit policy always wins. */
export function prepareOctocodeSkillLaunch(
	entry: McpServerEntry,
	cwd: string,
	skillDirectories: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): McpServerEntry {
	if (
		entry.name !== OCTOCODE_SERVER ||
		"url" in entry.config ||
		entry.config.env?.ALLOWED_PATHS !== undefined ||
		env.ALLOWED_PATHS !== undefined
	)
		return entry;
	return {
		...entry,
		config: {
			...entry.config,
			env: {
				...(env.WORKSPACE_ROOT === undefined ? { WORKSPACE_ROOT: cwd } : {}),
				...entry.config.env,
				ALLOWED_PATHS: octocodeAllowedPaths(cwd, skillDirectories, env),
			},
		},
	};
}
