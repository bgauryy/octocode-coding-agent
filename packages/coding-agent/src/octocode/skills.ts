import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir, getNativeSkillsDir } from "../config.ts";
import type { ExtensionAPI } from "../core/extensions/index.ts";
import { loadSkillsFromDir } from "../core/skills.ts";
import { claudeConfigDir, codexConfigDir } from "../utils/host-config.ts";
import { registerSkillDescriptions } from "./context-optimization/skills.ts";
import { EXTRA_SKILLS_ENV, envFlag, SUBAGENT_ENV } from "../../../common/src/env.ts";
import { globalPaths, projectSkillDirs, workspacePaths } from "./shared/home.ts";
import { projectTrust } from "./shared/trust.ts";

/**
 * Core discovery already loads ~/.agents/skills, the agent directory's skills and the project's .agents/skills and
 * .octocode/skills (up to the repository root), with the `skills` setting's patterns. This adds the directories other
 * agents use (Claude Code, Codex, Octocode's home) so one skill install works everywhere, minus any folder core already
 * reads: loading it again here would bypass those patterns and its project-over-user order.
 * Install Octocode skills with `npx octocode skill install <name>`. Octocode loads them and reports any name conflict itself.
 */
export function extraSkillDirs(
	cwd: string,
	home = os.homedir(),
	projectTrusted = true,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const claudeSkills = path.join(claudeConfigDir(home, env), "skills");
	let codexSkills: string[] = [];
	try {
		codexSkills = [path.join(codexConfigDir(home, env), "skills")];
	} catch {
		/* An invalid selected home must not discover a different user's profile. */
	}
	return [
		claudeSkills,
		...codexSkills,
		globalPaths(env, home).skills,
		// Like Octocode's own project skills, project directories (`.claude/skills` up to the root, `<root>/.octocode/skills`) load only for trusted projects.
		...(projectTrusted ? projectSkillDirs(cwd) : []),
	]
		.filter((dir) => !coreSkillDirs(cwd).has(path.resolve(dir)))
		.filter(isDirectory)
		.flatMap((dir) =>
			dir === claudeSkills || path.basename(path.dirname(dir)) === ".claude" ? withoutSynced(dir) : [dir],
		);
}

/** The Octocode skill folders core discovery reads itself: the agent directory's and the project's `.octocode/skills`. */
function coreSkillDirs(cwd: string): Set<string> {
	return new Set([path.join(getAgentDir(), "skills"), workspacePaths(cwd).skills].map((dir) => path.resolve(dir)));
}

function isDirectory(file: string): boolean {
	try {
		return fs.statSync(file).isDirectory();
	} catch {
		return false;
	}
}

/** Claude.ai's synced skills: they need claude.ai connectors Octocode does not have, and their broad triggers win over local skills. */
const SYNCED_SKILLS_DIR = "synced";

/**
 * A Claude `skills` folder without its `synced/` subtree. Octocode walks a skill directory recursively and has no exclude
 * option, so discover from the original root with Octocode's loader and pass explicit skill files outside `synced/`.
 * This preserves root-only loose Markdown and inherited ignore rules. A folder without `synced/`, or one that is a skill
 * itself (has SKILL.md), is returned as is.
 */
function withoutSynced(dir: string): string[] {
	if (!isDirectory(path.join(dir, SYNCED_SKILLS_DIR)) || fs.existsSync(path.join(dir, "SKILL.md"))) return [dir];
	const synced = path.join(dir, SYNCED_SKILLS_DIR) + path.sep;
	return loadSkillsFromDir({ dir, source: "path", protocol: "claude" })
		.skills.map((skill) => skill.filePath)
		.filter((file) => !file.startsWith(synced));
}

/**
 * Extra skill directories load in the root session. A native subagent starts with `--no-skills` and adopts its parent's
 * captured inventory, extra skills included, so it never discovers them itself; `OCTOCODE_SUBAGENT=1` also keeps any
 * other child process from doing so. `OCTOCODE_EXTRA_SKILLS=0` turns them off everywhere.
 */
export function extraSkillsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return !envFlag(env, SUBAGENT_ENV) && envFlag(env, EXTRA_SKILLS_ENV, true);
}

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
		const trusted = await projectTrust({
			cwd: event.cwd,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
			isProjectTrusted: () => ctx.isProjectTrusted(),
		});
		return { skillPaths: [...bundled, ...extraSkillDirs(event.cwd, undefined, trusted)] };
	});
}
