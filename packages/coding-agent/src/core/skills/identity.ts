import { basename, dirname, resolve } from "path";
import { canonicalizePath } from "../../../../common/src/paths.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import { isSyntheticPath, type SourceInfo } from "../source-info.ts";

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	"user-invocable"?: boolean;
	[key: string]: unknown;
}

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	/** Canonical instruction file captured when this resource was loaded. */
	canonicalPath?: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
	userInvocable?: boolean;
	argumentStyle?: "claude";
	claudePluginRoot?: string;
	claudePluginData?: string;
	argumentNames?: string[];
}

export interface ExplicitSkill {
	skill: Skill;
	name: string;
	canonicalPath: string;
	discoveryPath: string;
	promptByteLimit?: number;
}

export function explicitSkillIdentity(skill: Skill, name = skill.name): ExplicitSkill | undefined {
	if (basename(skill.filePath) !== "SKILL.md" || skill.argumentStyle === "claude" || skill.userInvocable === false)
		return undefined;
	return {
		skill,
		name,
		canonicalPath: skill.canonicalPath ?? canonicalizePath(skill.filePath),
		discoveryPath: resolve(skill.filePath),
	};
}

export interface LoadSkillsResult {
	explicitSkills?: ExplicitSkill[];
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/** Canonical reference roots of loaded resources, independent of command visibility. */
export function loadedSkillDirectories(loaded: LoadSkillsResult): string[] {
	const captured = new Map<string, string>();
	const directories = new Set<string>();
	for (const identity of loaded.explicitSkills ?? []) {
		if (
			identity.skill.userInvocable === false ||
			identity.skill.argumentStyle === "claude" ||
			isSyntheticPath(identity.canonicalPath) ||
			isSyntheticPath(identity.skill.sourceInfo.path)
		)
			continue;
		captured.set(resolve(identity.discoveryPath), identity.canonicalPath);
		directories.add(dirname(identity.canonicalPath));
	}
	for (const skill of loaded.skills) {
		if (isSyntheticPath(skill.filePath) || isSyntheticPath(skill.sourceInfo.path)) continue;
		const path = captured.get(resolve(skill.filePath)) ?? skill.canonicalPath ?? canonicalizePath(skill.filePath);
		directories.add(dirname(path));
	}
	return [...directories].sort();
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
	protocol?: "claude" | "codex";
}
