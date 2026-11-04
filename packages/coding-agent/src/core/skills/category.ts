import { isUnderPath } from "../../../../common/src/paths.ts";
import { getNativeSkillsDir } from "../../config.ts";

/**
 * Where a skill comes from, as agents and users see it:
 * - `core`: shipped inside Octocode itself (`native-skills/`), part of how the agent works;
 * - `external`: everything else (user and project folders, Claude and Codex folders, packages, settings, flags).
 */
export type SkillCategory = "core" | "external";

/** Display and catalog order: the agent's own skills first, external skills last (they lose descriptions first). */
export const SKILL_CATEGORIES: readonly SkillCategory[] = ["core", "external"];

let coreRoot: string | undefined;

/** The category of a loaded skill (or a skill file), from its path. */
export function skillCategory(skill: { filePath: string }): SkillCategory {
	coreRoot ??= getNativeSkillsDir();
	return isUnderPath(skill.filePath, coreRoot) ? "core" : "external";
}

/** The skills in category order, keeping their order within a category. */
export function sortByCategory<T>(items: readonly T[], category: (item: T) => SkillCategory): T[] {
	return SKILL_CATEGORIES.flatMap((wanted) => items.filter((item) => category(item) === wanted));
}
