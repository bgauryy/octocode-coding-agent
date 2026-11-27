import { renderPrompt } from "../../core/prompt-template.ts";
import { contentText } from "../shared/util.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { SessionEntry } from "../../core/session-manager.ts";
import { carriedRecords } from "./saved-results.ts";

/**
 * The skills loaded in the part of the conversation a summary replaces. A `skill` result is an ordinary tool result, so
 * compaction drops its instructions and nothing else says the skill was in use. Like the saved-results list, code names
 * them after the summary (one Recovery line of pointers) and keeps them in the compaction's `details.loadedSkills`, so
 * the next summary lists them again; the bodies of the most recently loaded ones come back after the compaction
 * (`restore-skills.ts`). A skill not loaded again across `SKILL_POINTER_COMPACTIONS` compactions leaves the list: the
 * work moved on from it, and a list that only grows crowds out what is current.
 */

/** The compaction `details` key that carries the skills into the next summary; a tool result lists the skills it delivered under it too. */
export const LOADED_SKILLS_DETAILS = "loadedSkills";

/** A carried skill is dropped once this many compactions in a row summarized no load of it. */
export const SKILL_POINTER_COMPACTIONS = 2;

export interface LoadedSkill {
	name: string;
	location: string;
	/** Compactions since the skill was last loaded; absent when the span the latest summary replaced loaded it. */
	idle?: number;
}

/**
 * A skill Octocode expanded into the user message (`/skill:name args` becomes `<skill name="…" location="…">body</skill>`
 * then the args).
 */
export const SKILL_BLOCK = /<skill name="([^"\n]*)" location="([^"\n]*)">\n[\s\S]*?\n<\/skill>/g;

/** The skills whose whole text `text` holds (a `SKILL_BLOCK`); a catalog line naming a skill and its file is not one. */
export function skillBlocksIn(text: string): Set<string> {
	return new Set([...text.matchAll(SKILL_BLOCK)].map(([, name]) => name));
}

/** A skill that fits one Recovery bullet: `splitSummary` removes that section by its one-line shape. */
function isLoadedSkill(value: unknown): value is LoadedSkill {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		value.name !== "" &&
		!value.name.includes("\n") &&
		typeof value.location === "string" &&
		value.location !== "" &&
		!value.location.includes("\n") &&
		(value.idle === undefined || (typeof value.idle === "number" && Number.isInteger(value.idle) && value.idle >= 0))
	);
}

/**
 * The skills `message` loaded: a successful `skill` result (its details name the file), a result that carried a skill
 * to the model (`details.loadedSkills`, as `skill/first-use.ts` does), or a `/skill:` block in a user message.
 */
export function skillsOf(message: unknown): LoadedSkill[] {
	if (!isRecord(message)) return [];
	if (message.role === "toolResult") {
		if (message.isError === true || !isRecord(message.details)) return [];
		const carried = message.details[LOADED_SKILLS_DETAILS];
		if (Array.isArray(carried)) return carried.filter(isLoadedSkill).map(({ name, location }) => ({ name, location }));
		return message.toolName === "skill" && isLoadedSkill(message.details)
			? [{ name: message.details.name, location: message.details.location }]
			: [];
	}
	if (message.role !== "user") return [];
	return [...contentText(message.content).matchAll(SKILL_BLOCK)].map(([, name, location]) => ({ name, location }));
}

/**
 * What the next summary records: each skill `messages` loaded (once by name, a later load's path winning), after those
 * `carried` from the earlier summary, each one compaction older unless `messages` load it again; a carried skill that
 * reaches `SKILL_POINTER_COMPACTIONS` leaves.
 */
export function loadedSkills(messages: readonly unknown[], carried: readonly LoadedSkill[] = []): LoadedSkill[] {
	const found = new Map<string, LoadedSkill>(
		carried.map(({ name, location, idle }) => [name, { name, location, idle: (idle ?? 0) + 1 }]),
	);
	for (const message of messages) for (const skill of skillsOf(message)) found.set(skill.name, skill);
	return [...found.values()].filter((skill) => (skill.idle ?? 0) < SKILL_POINTER_COMPACTIONS);
}

/**
 * The skills the latest summary on `branch` carries: its record, then, for each later compaction that kept none (the
 * default summary), the skills it summarized, the carried ones one compaction older each time.
 */
export function carriedLoadedSkills(branch: readonly SessionEntry[]): LoadedSkill[] {
	const { recorded, stretches } = carriedRecords(branch, LOADED_SKILLS_DETAILS);
	let skills = recorded.filter(isLoadedSkill);
	for (const stretch of stretches) skills = loadedSkills(stretch, skills);
	return skills;
}

/** The Recovery line naming `skills` (by name: `skill` loads one by its name), or none. */
export function loadedSkillsLines(skills: readonly LoadedSkill[]): string[] {
	if (skills.length === 0) return [];
	return [renderPrompt("notices/recovery/loaded-skills.md", { skills: skills.map((skill) => skill.name).join(", ") })];
}
