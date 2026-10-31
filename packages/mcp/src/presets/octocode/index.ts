import type { McpServerPreset } from "../../preset.ts";
import { envFlag, MCP_ENV } from "../../../../common/src/env.ts";
import { projectTrustNow } from "../../../../coding-agent/src/octocode/shared/trust.ts";
import { octocodeCompactOverrides } from "./compact-overrides.ts";
import { OCTOCODE_SERVER } from "./names.ts";
import { octocodeLaunch } from "./launch.ts";
import { literalConfigEnv } from "./literal.ts";
import { prepareOctocodeSkillLaunch } from "./skill-paths.ts";
import { defineOctocodeTool } from "./tools.ts";

export function octocodePreset(
	skillDirectories: () => readonly string[] = () => [],
	env: NodeJS.ProcessEnv = process.env,
): McpServerPreset {
	return {
		name: OCTOCODE_SERVER,
		config: { command: "octocode-mcp", inheritEnv: true, enabled: envFlag(env, MCP_ENV, true) },
		defineTool: defineOctocodeTool,
		compactOverrides: octocodeCompactOverrides,
		prepareLaunch(entry, cwd, trusted) {
			if (entry.scope === "default") {
				const launch = octocodeLaunch(
					cwd,
					env,
					undefined,
					skillDirectories(),
					trusted && projectTrustNow({ cwd, isProjectTrusted: () => trusted }) === true,
				);
				// The launch values are paths, not configuration: keep `${}` and `!` resolution away from them.
				return { ...entry, config: { ...entry.config, ...launch, env: literalConfigEnv(launch.env) } };
			}
			return prepareOctocodeSkillLaunch(entry, cwd, skillDirectories(), env);
		},
	};
}
