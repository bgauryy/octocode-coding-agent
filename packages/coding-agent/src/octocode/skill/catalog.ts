import type { Skill } from "../../core/skills.ts";
import type { SkillResourceSnapshot } from "../../core/skill-resource-snapshot.ts";
import { SKILL_CATALOG_ENV } from "@octocodeai/octocode-common/env";
import { isBundledSkill } from "../../core/skills/category.ts";
import { SkillListing } from "../../core/skills/listing.ts";

/** A skill loaded into this session, as the `skill` tool and the row renderers see it. */
export interface CatalogSkill {
	skill: Skill;
	/** The instruction file the loader captured: the only file the `skill` tool reads for this skill. */
	file: string;
}

/**
 * The skills this session loaded, read through the host's resource snapshot (`api.resources.getSkillResourceSnapshot`): the same
 * inventory a subagent inherits, with feature, plugin and Claude/Codex skills included. Every `skill` call re-reads
 * it, so a skill installed or removed in the session shows on the next call.
 */
export class SkillCatalog {
	private loaded: CatalogSkill[] = [];

	private readonly snapshot: () => SkillResourceSnapshot;

	/** Descriptions the user's optimization store replaced, by skill name; the listing shows these. */
	private described: ReadonlyMap<string, string> = new Map();

	/** A subagent's catalog leaves out the skills written for the coordinator (delegation, filing items). */
	private readonly forSubagent: boolean;

	/**
	 * The skills a subagent's listing names (its role's `catalog:`) among the bundled ones; the others stay loadable by name.
	 * Unset: every bundled skill. The user's and project's own skills are always listed.
	 */
	private readonly listed: readonly string[] | undefined;

	/** A lean main session lists no skills: its `skill` tool stays out of requests. */
	private withheld = false;

	constructor(snapshot: () => SkillResourceSnapshot, options: { subagent?: boolean; listed?: readonly string[] } = {}) {
		this.snapshot = snapshot;
		this.forSubagent = options.subagent === true;
		this.listed = options.listed;
	}

	/** The catalog of this process: a subagent lists the skills its role's `catalog:` names (`SKILL_CATALOG_ENV`). */
	static forSession(snapshot: () => SkillResourceSnapshot, subagent: boolean): SkillCatalog {
		const names = subagent ? process.env[SKILL_CATALOG_ENV]?.split(",").filter(Boolean) : undefined;
		return new SkillCatalog(snapshot, { subagent, listed: names });
	}

	/** Stop (or resume) listing skills to the model; loading by name is unaffected. */
	withhold(withheld: boolean): void {
		this.withheld = withheld;
	}

	/** Rendering may retain the last good list; execution requires a currently valid snapshot. */
	refresh({ allowStale = true }: { allowStale?: boolean } = {}): CatalogSkill[] {
		try {
			this.loaded = this.snapshot().resources.flatMap((resource) =>
				resource.visible && !(this.forSubagent && resource.skill.audience === "coordinator")
					? [{ skill: resource.skill, file: resource.canonicalPath }]
					: [],
			);
		} catch (error) {
			if (!allowStale) throw error;
			/* A failing snapshot may retain display metadata, but it must never authorize a file read. */
		}
		return this.loaded;
	}

	/** Show `descriptions` (skill name to text) in place of the skills' own, for the listing a model reads. */
	describeAs(descriptions: ReadonlyMap<string, string>): void {
		this.described = descriptions;
	}

	/** Skills the model may load: those without `disable-model-invocation`, which only the user starts. */
	invocable(): CatalogSkill[] {
		return this.refresh().filter((entry) => !entry.skill.disableModelInvocation);
	}

	/** The invocable skills as the grouped list the `skill` tool's description carries. */
	listing(): SkillListing {
		if (this.withheld) return SkillListing.of([]);
		const shown = (skill: Skill) =>
			!this.forSubagent || !isBundledSkill(skill) || !this.listed || this.listed.includes(skill.name);
		return SkillListing.of(
			this.refresh()
				.filter(({ skill }) => shown(skill))
				.map(({ skill, file }) => {
					const description = this.described.get(skill.name);
					return { skill: description === undefined ? skill : { ...skill, description }, file };
				}),
		);
	}
}

/** Edits between two names: insertions, deletions, substitutions and swaps of adjacent letters (`wbe` is one from `web`). */
export function editDistance(a: string, b: string): number {
	let previous: number[] = [];
	let row = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const next = [i];
		for (let j = 1; j <= b.length; j++) {
			next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
				next[j] = Math.min(next[j], previous[j - 2] + 1);
		}
		previous = row;
		row = next;
	}
	return row[b.length];
}

/** Skill names close to `name`: containing it, contained in it, or a few edits away; at most five, closest first. */
export function closeNames(name: string, names: readonly string[]): string[] {
	const wanted = name.toLowerCase();
	return names
		.map((candidate) => {
			const lower = candidate.toLowerCase();
			const near = lower.includes(wanted) || wanted.includes(lower);
			return { candidate, score: near ? 0 : editDistance(wanted, lower) };
		})
		.filter(({ score }) => score <= Math.max(2, Math.floor(wanted.length / 3)))
		.sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
		.slice(0, 5)
		.map(({ candidate }) => candidate);
}
