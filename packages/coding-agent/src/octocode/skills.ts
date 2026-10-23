import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "../core/extensions/index.ts";
import { loadSkillsFromDir } from "../core/skills.ts";
import { claudeConfigDir, codexConfigDir } from "../utils/host-config.ts";
import { EXTRA_SKILLS_ENV, envFlag, SUBAGENT_ENV } from "./shared/env.ts";
import { globalPaths, projectSkillDirs } from "./shared/home.ts";
import { projectTrust } from "./shared/trust.ts";

/**
 * Octocode already loads skills from ~/.agents/skills, ~/.octocode/agent/skills and the
 * project's .agents/skills and .octocode/skills. Octocode adds the directories other
 * agents use (Claude Code, Codex, Octocode's home) so one skill install works everywhere.
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
	try { codexSkills = [path.join(codexConfigDir(home, env), "skills")]; }
	catch { /* An invalid selected home must not discover a different user's profile. */ }
	return [
		claudeSkills,
		...codexSkills,
		globalPaths(env, home).skills,
		// Like Octocode's own project skills, project directories (`.claude/skills` up to the root, `<root>/.octocode/skills`) load only for trusted projects.
		...(projectTrusted ? projectSkillDirs(cwd) : []),
	]
		.filter(isDirectory)
		.flatMap((dir) => (dir === claudeSkills || path.basename(path.dirname(dir)) === ".claude" ? withoutSynced(dir) : [dir]));
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
 * Extra skill directories are listed in every prompt, so they load only in the root session: a subagent
 * (`OCTOCODE_SUBAGENT=1`) gets just the skills Octocode itself discovers. `OCTOCODE_EXTRA_SKILLS=0` turns them off everywhere.
 */
export function extraSkillsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return !envFlag(env, SUBAGENT_ENV) && envFlag(env, EXTRA_SKILLS_ENV, true);
}

export function registerSkills(pi: ExtensionAPI): void {
	pi.on("resources_discover", async (event, ctx) => {
		if (!extraSkillsEnabled()) return { skillPaths: [] };
		const trusted = await projectTrust({
			cwd: event.cwd,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
			isProjectTrusted: () => ctx.isProjectTrusted(),
		});
		return { skillPaths: extraSkillDirs(event.cwd, undefined, trusted) };
	});
}
