/**
 * Optimized skill descriptions: what the skills listing of an agent's system prompt shows instead of each skill's own
 * description. Sessions record every skill they discover with a hash of its source description (`syncSkills`); a
 * rewrite applies only while that hash matches, so an edited SKILL.md falls back to its own wording until it is
 * rewritten again. Each scope has its own store (`contextOptimizationDirs`): `skills.json` in the user folder for
 * user-level skills and in the project folder for skills inside the repository, with `skills.txt` showing the
 * descriptions agents read.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync, sha256 } from "../../utils/atomic-file.ts";
import { isRecord } from "../../utils/guards.ts";

/** The Agent Skills limit for a description; the prompt cuts a longer one. */
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;

/** A skill as discovery found it. */
export interface SkillSource {
	name: string;
	description: string;
	file: string;
}

export interface StoredSkill {
	/** {@link skillHash} of the source description the rewrite was written for. */
	hash: string;
	file: string;
	source: string;
	/** The rewrite agents read; absent until one is applied. */
	description?: string;
	optimizedBy?: { model: string; at: string };
}

export interface SkillsStore {
	version: 1;
	skills: Record<string, StoredSkill>;
}

const emptyStore = (): SkillsStore => ({ version: 1, skills: {} });

export function skillsStoreFile(dir: string): string {
	return join(dir, "skills.json");
}

export function skillHash(name: string, description: string): string {
	return sha256(`${name}\0${description}`);
}

function isStoredSkill(value: unknown): value is StoredSkill {
	return (
		isRecord(value) &&
		typeof value.hash === "string" &&
		typeof value.file === "string" &&
		typeof value.source === "string" &&
		(value.description === undefined || typeof value.description === "string")
	);
}

/** The stored skills; an empty store when the file is missing or unreadable, which only costs the rewrites. */
export function readSkillsStore(dir: string): SkillsStore {
	try {
		const parsed: unknown = JSON.parse(readFileSync(skillsStoreFile(dir), "utf8"));
		if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.skills)) return emptyStore();
		const skills = Object.fromEntries(Object.entries(parsed.skills).filter(([, entry]) => isStoredSkill(entry)));
		return { version: 1, skills: skills as Record<string, StoredSkill> };
	} catch {
		return emptyStore();
	}
}

/** The descriptions agents read, one skill per paragraph, for inspection. */
export function renderSkillsView(store: SkillsStore): string {
	return Object.entries(store.skills)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, entry]) => `${name}${entry.description ? "" : " (source)"}\n${entry.description ?? entry.source}`)
		.join("\n\n");
}

export function writeSkillsStore(dir: string, store: SkillsStore): void {
	mkdirSync(dir, { recursive: true });
	atomicWriteFileSync(join(dir, "skills.txt"), `${renderSkillsView(store)}\n`);
	atomicWriteFileSync(skillsStoreFile(dir), `${JSON.stringify(store, null, "\t")}\n`);
}

/**
 * Record `skills` as discovered. A skill whose source description changed loses its rewrite; skills not discovered now
 * stay, because another project may load them. Returns the names that are new or changed, and whether the store changed.
 */
export function syncSkills(
	store: SkillsStore,
	skills: readonly SkillSource[],
): { store: SkillsStore; changed: string[]; dirty: boolean } {
	const next: SkillsStore = { version: 1, skills: { ...store.skills } };
	const changed: string[] = [];
	let dirty = false;
	for (const skill of skills) {
		const hash = skillHash(skill.name, skill.description);
		const previous = next.skills[skill.name];
		if (previous?.hash === hash) {
			if (previous.file !== skill.file) {
				next.skills[skill.name] = { ...previous, file: skill.file };
				dirty = true;
			}
			continue;
		}
		next.skills[skill.name] = { hash, file: skill.file, source: skill.description };
		changed.push(skill.name);
		dirty = true;
	}
	return { store: next, changed, dirty };
}

/**
 * The description an agent reads: the first rewrite among `stores` written for exactly this source description, else
 * the source. Pass the project's store before the user's.
 */
export function effectiveDescription(stores: readonly SkillsStore[], name: string, description: string): string {
	const hash = skillHash(name, description);
	for (const store of stores) {
		const entry = store.skills[name];
		if (entry?.description && entry.hash === hash) return entry.description;
	}
	return description;
}

/** Rewrites read from JSON: `{ "skills": { "<name>": "<description>" } }`. */
export function parseSkillOverrides(value: unknown): { overrides: Record<string, string> } | { error: string } {
	if (!isRecord(value)) return { error: "overrides must be a JSON object" };
	const unknown = Object.keys(value).filter((key) => key !== "skills");
	if (unknown.length)
		return { error: `unknown overrides key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}` };
	const skills = value.skills;
	if (!isRecord(skills) || !Object.values(skills).every((entry) => typeof entry === "string"))
		return { error: '"skills" must map skill names to descriptions' };
	return { overrides: skills as Record<string, string> };
}

/** Why each rewrite cannot be applied: an unknown skill, an empty or over-long description, or more than one paragraph. */
export function checkSkillOverrides(store: SkillsStore, overrides: Record<string, string>): string[] {
	const problems: string[] = [];
	for (const [name, description] of Object.entries(overrides)) {
		const text = description.trim();
		if (!store.skills[name]) problems.push(`${name}: no discovered skill has this name`);
		else if (!text) problems.push(`${name}: the description is empty`);
		else if (text.length > SKILL_DESCRIPTION_MAX_CHARS)
			problems.push(`${name}: ${text.length} characters, over the ${SKILL_DESCRIPTION_MAX_CHARS}-character limit`);
		else if (/\n\s*\n/.test(text)) problems.push(`${name}: write one paragraph`);
	}
	return problems;
}

/** `store` with the rewrites applied to the current source of each named skill. Check them first. */
export function applySkillOverrides(
	store: SkillsStore,
	overrides: Record<string, string>,
	optimizedBy?: string,
): SkillsStore {
	const next: SkillsStore = { version: 1, skills: { ...store.skills } };
	const at = new Date().toISOString();
	for (const [name, description] of Object.entries(overrides)) {
		const entry = next.skills[name];
		if (!entry) continue;
		const { optimizedBy: _previous, ...rest } = entry;
		next.skills[name] = {
			...rest,
			description: description.trim(),
			...(optimizedBy ? { optimizedBy: { model: optimizedBy, at } } : {}),
		};
	}
	return next;
}
