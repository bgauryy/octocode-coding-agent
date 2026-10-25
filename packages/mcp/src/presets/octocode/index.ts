import type { McpServerPreset } from "../../preset.ts";
import { envFlag, MCP_ENV } from "../../../../coding-agent/src/octocode/shared/env.ts";
import { projectTrustNow } from "../../../../coding-agent/src/octocode/shared/trust.ts";
import { OCTOCODE_DIRECT_TOOLS, OCTOCODE_SERVER } from "./names.ts";
import { octocodeLaunch } from "./launch.ts";
import { prepareOctocodeSkillLaunch } from "./skill-paths.ts";
import { defineOctocodeTool } from "./tools.ts";

export function octocodePreset(
	skillDirectories: () => readonly string[] = () => [],
	env: NodeJS.ProcessEnv = process.env,
): McpServerPreset {
	return {
		name: OCTOCODE_SERVER,
		config: { command: "octocode-mcp", inheritEnv: true, enabled: envFlag(env, MCP_ENV, true) },
		toolExposure: Object.fromEntries(OCTOCODE_DIRECT_TOOLS.map((name) => [name, "direct"])),
		preferDeferred: true,
		defineTool: defineOctocodeTool,
		prepareLaunch(entry, cwd, trusted) {
			if (entry.scope === "default") {
				const launch = octocodeLaunch(
					cwd,
					env,
					undefined,
					skillDirectories(),
					trusted && projectTrustNow({ cwd, isProjectTrusted: () => trusted }) === true,
				);
				return { ...entry, config: { ...entry.config, ...launch } };
			}
			return prepareOctocodeSkillLaunch(entry, cwd, skillDirectories(), env);
		},
	};
}
