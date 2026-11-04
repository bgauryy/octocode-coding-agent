import { getNativeSkillsDir } from "../config.ts";
import type { ExtensionAPI } from "../core/features/index.ts";
import { isDirectory } from "../utils/fs-probe.ts";
import { registerSkillDescriptions } from "./context-optimization/skills.ts";
import { envFlag, SUBAGENT_ENV } from "../../../common/src/env.ts";
import { extraSkillDirs, extraSkillsEnabled } from "./skill/folders.ts";

export { extraSkillDirs, extraSkillsEnabled };

/**
 * Skills the application ships (`octocode-context-optimization`). A native subagent adopts its parent's inventory, so only a root
 * session discovers them; `OCTOCODE_EXTRA_SKILLS=0` does not remove them, because they are not another agent's folders.
 */
export function bundledSkillDirs(env: NodeJS.ProcessEnv = process.env): string[] {
	return envFlag(env, SUBAGENT_ENV) ? [] : [getNativeSkillsDir()].filter(isDirectory);
}

export function registerSkills(api: ExtensionAPI): void {
	registerSkillDescriptions(api, { isSubagent: envFlag(process.env, SUBAGENT_ENV) });
	api.on("resources_discover", async (event, ctx) => {
		const bundled = bundledSkillDirs();
		if (!extraSkillsEnabled()) return { skillPaths: bundled };
		return { skillPaths: [...bundled, ...extraSkillDirs(event.cwd, undefined, ctx.isProjectTrusted())] };
	});
}
