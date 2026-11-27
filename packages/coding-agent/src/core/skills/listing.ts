import { dirname, relative } from "node:path";
import { SKILL_CATEGORIES, type SkillCategory, skillCategory } from "./category.ts";
import type { Skill } from "./identity.ts";
import { skillSummary } from "./summary.ts";

/** A skill as the `skill` tool lists it: the file a call loads it from and its description's summary (`skillSummary`). */
export class SkillEntry {
	readonly name: string;
	readonly path: string;
	readonly description: string;
	readonly category: SkillCategory;

	constructor(skill: Skill, file: string) {
		this.name = skill.name;
		this.path = file;
		this.description = skillSummary(skill.description?.trim() ?? "");
		this.category = skillCategory(skill);
	}

	/** One line: `path: description`, or the path alone for a skill an SDK caller supplied without one; `shown` is the path as listed. */
	render(shown: string = this.path): string {
		return this.description ? `${shown}: ${this.description}` : shown;
	}
}

/** Categories whose skills all sit under one install folder, so the folder is stated once instead of on every line. */
const SHARED_ROOT_CATEGORIES: readonly SkillCategory[] = ["core", "octocode"];

/** The folder holding every skill folder of `entries` (the parent of each `<name>/SKILL.md`), when they share one. */
function sharedRoot(entries: readonly SkillEntry[]): string | undefined {
	if (entries.length < 2) return undefined;
	const root = dirname(dirname(entries[0].path));
	return entries.every((entry) => dirname(dirname(entry.path)) === root) ? root : undefined;
}

/** The entries of one category, in listing order. */
export class SkillGroup {
	readonly category: SkillCategory;
	readonly entries: readonly SkillEntry[];
	/** The folder a bundled group's entries are listed relative to; undefined when each line carries its full path. */
	readonly root: string | undefined;

	constructor(category: SkillCategory, entries: readonly SkillEntry[]) {
		this.category = category;
		this.entries = entries;
		this.root = SHARED_ROOT_CATEGORIES.includes(category) ? sharedRoot(entries) : undefined;
	}

	/** The path as listed: relative to the group's `root` when it has one. */
	listed(entry: SkillEntry): string {
		return this.root === undefined ? entry.path : relative(this.root, entry.path);
	}

	/** `<core_skills>`, `<octocode_skills>`, `<workspace_skills>` or `<global_skills>` around the entry lines, after a `root:` line when the paths are relative. */
	render(): string {
		const tag = `${this.category}_skills`;
		const rootLine = this.root === undefined ? [] : [`root: ${this.root}`];
		return [
			`<${tag}>`,
			...rootLine,
			...this.entries.map((entry) => entry.render(this.listed(entry))),
			`</${tag}>`,
		].join("\n");
	}
}

/**
 * The skills a model may load, grouped by category (core, Octocode, workspace, global; an empty group is left out) and
 * every entry carries its description's summary, so each enabled skill stays listed. It is the one place a skill is named for the model,
 * so the `skill` tool's description, its name lookup and the listing budget read the same object.
 */
export class SkillListing {
	readonly groups: readonly SkillGroup[];

	private constructor(groups: readonly SkillGroup[]) {
		this.groups = groups;
	}

	/** The listing of `skills` a model may invoke (those without `disable-model-invocation`), each with the file it loads from. */
	static of(skills: readonly { skill: Skill; file: string }[]): SkillListing {
		const entries = skills
			.filter(({ skill }) => !skill.disableModelInvocation)
			.map(({ skill, file }) => new SkillEntry(skill, file));
		return new SkillListing(
			SKILL_CATEGORIES.flatMap((category) => {
				const own = entries.filter((entry) => entry.category === category);
				return own.length > 0 ? [new SkillGroup(category, own)] : [];
			}),
		);
	}

	/** The listing of loaded skills read from their own files. */
	static fromSkills(skills: readonly Skill[]): SkillListing {
		return SkillListing.of(skills.map((skill) => ({ skill, file: skill.filePath })));
	}

	get entries(): SkillEntry[] {
		return this.groups.flatMap((group) => [...group.entries]);
	}

	get isEmpty(): boolean {
		return this.groups.length === 0;
	}

	/** The entry a call's reference names: its path (full, or as listed under a group's `root`), or its name (exact, then in any case). */
	find(reference: string): SkillEntry | undefined {
		const all = this.entries;
		const listed = this.groups.flatMap((group) => group.entries.map((entry) => [group.listed(entry), entry] as const));
		return (
			all.find((entry) => entry.path === reference) ??
			listed.find(([path]) => path === reference)?.[1] ??
			all.find((entry) => entry.name === reference) ??
			all.find((entry) => entry.name.toLowerCase() === reference.toLowerCase())
		);
	}

	/** The grouped lines the model reads; empty when no skill is listed. */
	render(): string {
		return this.groups.map((group) => group.render()).join("\n");
	}
}
