import type { SkillCategory } from "./skills/category.ts";

/**
 * The port through which core learns which skills the user has not approved (the extension guard). Core never reads
 * review records and never imports `octocode/`: the host installs a reviewer (`octocode/guard/install.ts`) and core drops
 * the skill files it names. Without a reviewer every skill loads. Octocode's own skills (`core`, `octocode`) are never
 * asked about.
 */

export interface SkillReviewInput {
	name: string;
	filePath: string;
	category: SkillCategory;
}

/** The `filePath`s among `skills` that stay off, for a session in `cwd`. Must not throw: a fault loads everything. */
export type SkillReviewer = (
	skills: readonly SkillReviewInput[],
	cwd: string,
	shipped: ReadonlySet<string>,
) => ReadonlySet<string>;

let reviewer: SkillReviewer | undefined;

export function installSkillReviewer(next: SkillReviewer): void {
	reviewer = next;
}

/** The skill files to leave out; empty without a reviewer. */
export function withheldSkills(
	skills: readonly SkillReviewInput[],
	cwd: string,
	shipped: ReadonlySet<string>,
): ReadonlySet<string> {
	return reviewer ? reviewer(skills, cwd, shipped) : new Set();
}
