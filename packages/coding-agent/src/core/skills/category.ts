import { isUnderPath } from "@octocodeai/octocode-common/paths";
import { getNativeSkillsDir, getOctocodeSkillsDir } from "../../config.ts";

/**
 * Where a skill comes from, as agents and users see it:
 * - `core`: shipped inside Octocode itself (`native/skills/`), part of how the agent works;
 * - `octocode`: the public Octocode skill collection of the installed research CLI (resource source `builtin`);
 * - `workspace`: the project's own skills (scope `project`: `.octocode/skills/`, `.agents/skills/`, `.claude/skills/`, ...);
 * - `global`: everything else (the user's folders, other tools' user folders, packages, settings, `--skill`).
 */
export type SkillCategory = "core" | "octocode" | "workspace" | "global";

/** Display and catalog order: Octocode's own skills first, then the project's, then the user's. */
export const SKILL_CATEGORIES: readonly SkillCategory[] = ["core", "octocode", "workspace", "global"];

let roots: { core: string; octocode: string | undefined } | undefined;

function categoryRoots(): { core: string; octocode: string | undefined } {
	roots ??= { core: getNativeSkillsDir(), octocode: getOctocodeSkillsDir() };
	return roots;
}

/** The category of a loaded skill (or a skill file), from its path and the loader's source and scope. */
export function skillCategory(skill: {
	filePath: string;
	sourceInfo?: { source: string; scope: string };
}): SkillCategory {
	const { core, octocode } = categoryRoots();
	if (isUnderPath(skill.filePath, core)) return "core";
	// Built-in features share the `builtin` source but have no file (`<builtin:id>`); a builtin file is a collection skill.
	const collectionFile = skill.sourceInfo?.source === "builtin" && !skill.filePath.startsWith("<builtin:");
	if (collectionFile || (octocode && isUnderPath(skill.filePath, octocode))) return "octocode";
	return skill.sourceInfo?.scope === "project" ? "workspace" : "global";
}

/** Whether Octocode ships the skill (`core` or its `octocode` collection), not the user's workspace or home folders. */
export function isBundledSkill(skill: Parameters<typeof skillCategory>[0]): boolean {
	const category = skillCategory(skill);
	return category === "core" || category === "octocode";
}

/** The skills in category order, keeping their order within a category. */
export function sortByCategory<T>(items: readonly T[], category: (item: T) => SkillCategory): T[] {
	return SKILL_CATEGORIES.flatMap((wanted) => items.filter((item) => category(item) === wanted));
}
