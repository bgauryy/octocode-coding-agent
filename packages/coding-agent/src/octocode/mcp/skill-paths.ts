import type { McpServerEntry } from "../../extensions/mcp/config.ts";
import { octocodeHome } from "../shared/home.ts";
import { OCTOCODE_SERVER } from "../shared/octocode-tools.ts";

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
				ALLOWED_PATHS: [...new Set([cwd, octocodeHome(env), ...skillDirectories])].join(","),
			},
		},
	};
}
