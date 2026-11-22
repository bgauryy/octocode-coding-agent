import { getNativeSkillsDir } from "../config.ts";
import type { FeatureSetup } from "../core/features/index.ts";
import { isDirectory } from "../utils/fs-probe.ts";
import { registerSkillDescriptions } from "./context-optimization/skills.ts";
import type { SkillCatalog } from "./skill/catalog.ts";
import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";

/**
 * Skills the application ships (`octocode-context-optimization`). A native subagent adopts its parent's inventory, so only a root
 * session discovers them; `OCTOCODE_EXTRA_SKILLS=0` does not remove them, because they are not another agent's folders.
 */
export function bundledSkillDirs(env: NodeJS.ProcessEnv = process.env): string[] {
	return envFlag(env, SUBAGENT_ENV) ? [] : [getNativeSkillsDir()].filter(isDirectory);
}

export function registerSkills(api: FeatureSetup, catalog: SkillCatalog): void {
	registerSkillDescriptions(api, catalog, { isSubagent: envFlag(process.env, SUBAGENT_ENV) });
	api.bus.on("resources_discover", async () => {
		// Other agents' skill folders and Octocode's home load through discovery (their harness switch decides).
		return { skillPaths: bundledSkillDirs() };
	});
}
