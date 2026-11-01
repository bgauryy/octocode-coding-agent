import type { McpServerPreset } from "../../preset.ts";
import { envFlag, MCP_ENV } from "../../../../common/src/env.ts";
import { hostTrust } from "../../host.ts";
import { octocodeCompactOverrides } from "./compact-overrides.ts";
import { OCTOCODE_SERVER } from "./names.ts";
import { octocodeLaunch } from "./launch.ts";
import { literalConfigEnv } from "./literal.ts";
import { prepareOctocodeSkillLaunch } from "./skill-paths.ts";
import { takeOctocodeWarnings } from "./warnings.ts";
import { defineOctocodeTool } from "./tools.ts";

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
			description: "Code research: local search and reading, language-server lookups, GitHub and package registries.",
		},
		defineTool: defineOctocodeTool,
		compactOverrides: octocodeCompactOverrides,
		takeWarnings: takeOctocodeWarnings,
		prepareLaunch(entry, cwd, trusted) {
			if (entry.scope === "default") {
				const launch = octocodeLaunch(
					cwd,
					env,
					undefined,
					skillDirectories(),
					trusted && hostTrust().contentTrusted({ cwd, isProjectTrusted: () => trusted }) === true,
				);
				// The launch values are paths, not configuration: keep `${}` and `!` resolution away from them.
				return { ...entry, config: { ...entry.config, ...launch, env: literalConfigEnv(launch.env) } };
			}
			return prepareOctocodeSkillLaunch(entry, cwd, skillDirectories(), env);
		},
	};
}
