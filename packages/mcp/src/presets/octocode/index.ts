import type { McpServerPreset } from "../../preset.ts";
import { envFlag, MCP_ENV } from "../../../../common/src/env.ts";
import { OCTOCODE_SERVER } from "./names.ts";
import { octocodeLaunch } from "./launch.ts";
import { literalConfigEnv } from "./literal.ts";
import { prepareOctocodeSkillLaunch } from "./skill-paths.ts";
import { takeOctocodeWarnings } from "./warnings.ts";
import { defineOctocodeTool } from "./tools.ts";

/**
 * Legacy: the default registration uses `src/recommended/octocode.json`. This legacy preset (launch from the linked
 * package) remains only for coding-agent tests that construct it; B48 W4/W5 delete it.
 */
export function octocodePreset(
	skillDirectories: () => readonly string[] = () => [],
	env: NodeJS.ProcessEnv = process.env,
): McpServerPreset {
	return {
		name: OCTOCODE_SERVER,
		config: {
			command: "octocode-mcp",
			inheritEnv: true,
			enabled: envFlag(env, MCP_ENV, true),
			description:
				"Every code search and read: this checkout (localSearch, structureSearch, localFetch, lspSearch, astSearch), GitHub repositories and package registries; use before bash or web.",
		},
		defineTool: defineOctocodeTool,
		takeWarnings: takeOctocodeWarnings,
		prepareLaunch(entry, cwd, trusted) {
			if (entry.scope === "default") {
				const launch = octocodeLaunch(cwd, env, undefined, skillDirectories(), trusted);
				// The launch values are paths, not configuration: keep `${}` and `!` resolution away from them.
				return { ...entry, config: { ...entry.config, ...launch, env: literalConfigEnv(launch.env) } };
			}
			return prepareOctocodeSkillLaunch(entry, cwd, skillDirectories(), env);
		},
	};
}
