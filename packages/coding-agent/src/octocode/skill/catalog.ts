import path from "node:path";
import type { Skill } from "../../core/skills.ts";
import type { SkillResourceSnapshot } from "../../core/skill-resource-snapshot.ts";

/** A skill loaded into this session, as the `skill` tool and the row renderers see it. */
export interface CatalogSkill {
	skill: Skill;
	/** The instruction file the loader captured: the only file the `skill` tool reads for this skill. */
	file: string;
}

/** A miss on a `SKILL.md` path re-reads the session's skills at most this often: rendering must stay cheap. */
const REFRESH_MS = 2_000;

/**
 * The skills this session loaded, read through the host's resource snapshot (`api.getSkillResourceSnapshot`): the same
 * inventory a subagent inherits, with extension, plugin and Claude/Codex skills included. Every `skill` call re-reads
 * it, so a skill installed or removed in the session shows on the next call.
 */
export class SkillCatalog {
	private loaded: CatalogSkill[] = [];
	private refreshedAt = 0;

	private readonly snapshot: () => SkillResourceSnapshot;

	constructor(snapshot: () => SkillResourceSnapshot) {
		this.snapshot = snapshot;
	}

	/** Rendering may retain the last good list; execution requires a currently valid snapshot. */
	refresh({ allowStale = true }: { allowStale?: boolean } = {}): CatalogSkill[] {
		this.refreshedAt = Date.now();
		try {
			this.loaded = this.snapshot().resources.flatMap((resource) =>
				resource.visible ? [{ skill: resource.skill, file: resource.canonicalPath }] : [],
			);
		} catch (error) {
			if (!allowStale) throw error;
			/* A failing snapshot may retain display metadata, but it must never authorize a file read. */
		}
		return this.loaded;
	}

	/** Skills the model may load: those without `disable-model-invocation`, which only the user starts. */
	invocable(): CatalogSkill[] {
		return this.refresh().filter((entry) => !entry.skill.disableModelInvocation);
	}

	/** The loaded skill whose instruction file is `file` (relative paths resolve against `cwd`), from the last refresh. */
	byFile(file: string, cwd: string): CatalogSkill | undefined {
		const target = path.resolve(cwd, file);
		const find = () =>
			this.loaded.find((entry) => target === path.resolve(entry.skill.filePath) || target === entry.file);
		const found = find();
		if (found || path.basename(target) !== "SKILL.md" || Date.now() - this.refreshedAt < REFRESH_MS) return found;
		this.refresh();
		return find();
	}
}

let active: SkillCatalog | undefined;

/** The session's catalog, for renderers that have no handle on the extension API. */
export function setActiveSkillCatalog(catalog: SkillCatalog | undefined, onlyIf?: SkillCatalog): void {
	if (onlyIf === undefined || active === onlyIf) active = catalog;
}

/** The skill name of a `localFetch` call that reads exactly one loaded skill's instruction file, else undefined. */
export function skillNameOfRead(args: unknown, cwd: string): string | undefined {
	if (!active || typeof args !== "object" || args === null) return undefined;
	const queries = (args as { queries?: unknown }).queries;
	if (!Array.isArray(queries) || queries.length !== 1) return undefined;
	const file = (queries[0] as { path?: unknown } | null)?.path;
	return typeof file === "string" && file ? active.byFile(file, cwd)?.skill.name : undefined;
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
