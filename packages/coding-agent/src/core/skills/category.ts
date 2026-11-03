import { isUnderPath } from "../../../../common/src/paths.ts";
import { getBundledSkillsDir, getNativeSkillsDir } from "../../config.ts";

/**
 * Where a skill comes from, as agents and users see it:
 * - `core`: shipped inside Octocode itself (`native-skills/`), part of how the agent works;
 * - `octocode`: the public Octocode skill collection bundled with the research CLI;
 * - `external`: everything else (user and project folders, Claude and Codex folders, packages, settings, flags).
 */
export type SkillCategory = "core" | "octocode" | "external";

/** Display and catalog order: the agent's own skills first, external skills last (they lose descriptions first). */
export const SKILL_CATEGORIES: readonly SkillCategory[] = ["core", "octocode", "external"];

let roots: { core: string; octocode: string | undefined } | undefined;

function categoryRoots(): { core: string; octocode: string | undefined } {
	if (!roots) {
		let octocode: string | undefined;
		try {
			octocode = getBundledSkillsDir();
		} catch {
			// Without the research CLI installed there is no bundled collection; its skills keep `source: "builtin"`.
		}
		roots = { core: getNativeSkillsDir(), octocode };
	}
	return roots;
}

/** The category of a loaded skill (or a skill file), from its path and the loader's source. */
export function skillCategory(skill: { filePath: string; sourceInfo?: { source: string } }): SkillCategory {
	const { core, octocode } = categoryRoots();
	if (isUnderPath(skill.filePath, core)) return "core";
	if (skill.sourceInfo?.source === "builtin" || (octocode && isUnderPath(skill.filePath, octocode))) return "octocode";
	return "external";
}

/** The skills in category order, keeping their order within a category. */
export function sortByCategory<T>(items: readonly T[], category: (item: T) => SkillCategory): T[] {
	return SKILL_CATEGORIES.flatMap((wanted) => items.filter((item) => category(item) === wanted));
}
