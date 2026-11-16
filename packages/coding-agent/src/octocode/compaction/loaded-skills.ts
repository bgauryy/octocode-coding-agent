import { renderInstruction } from "../../core/prompt-template.ts";
import { contentText } from "../shared/util.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { SessionEntry } from "../../core/session-manager.ts";
import { carriedRecords } from "./saved-results.ts";

/**
 * The skills loaded in the part of the conversation a summary replaces. A `skill` result is an ordinary tool result, so
 * compaction drops its instructions and nothing else says the skill was in use. Like the saved-results list, code names
 * them after the summary (one Recovery line, pointers only, never a skill's body) and keeps them in the compaction's
 * `details.loadedSkills`, so the next summary lists them again.
 */

/** The compaction `details` key that carries the skills into the next summary. */
export const LOADED_SKILLS_DETAILS = "loadedSkills";

interface LoadedSkill {
	name: string;
	location: string;
}

/**
 * A skill Octocode expanded into the user message (`/skill:name args` becomes `<skill name="…" location="…">body</skill>`
 * then the args).
 */
export const SKILL_BLOCK = /<skill name="([^"\n]*)" location="([^"\n]*)">\n[\s\S]*?\n<\/skill>/g;

/** A skill that fits one Recovery bullet: `splitSummary` removes that section by its one-line shape. */
function isLoadedSkill(value: unknown): value is LoadedSkill {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		value.name !== "" &&
		!value.name.includes("\n") &&
		typeof value.location === "string" &&
		value.location !== "" &&
		!value.location.includes("\n")
	);
}

/** The skills `message` loaded: a successful `skill` result (its details name the file), or a `/skill:` block in a user message. */
function skillsOf(message: unknown): LoadedSkill[] {
	if (!isRecord(message)) return [];
	if (message.role === "toolResult")
		return message.toolName === "skill" && message.isError !== true && isLoadedSkill(message.details)
			? [{ name: message.details.name, location: message.details.location }]
			: [];
	if (message.role !== "user") return [];
	return [...contentText(message.content).matchAll(SKILL_BLOCK)].map(([, name, location]) => ({ name, location }));
}

/** Each skill `messages` loaded, once by name, after those `carried` from the earlier summary; a later load's path wins. */
export function loadedSkills(messages: readonly unknown[], carried: readonly LoadedSkill[] = []): LoadedSkill[] {
	const found = new Map(carried.map((skill) => [skill.name, skill]));
	for (const message of messages) for (const skill of skillsOf(message)) found.set(skill.name, skill);
	return [...found.values()];
}

/** The skills earlier summaries carried, and those a compaction without a record (the default summary) summarized. */
export function carriedLoadedSkills(branch: readonly SessionEntry[]): LoadedSkill[] {
	const { recorded, stretches } = carriedRecords(branch, LOADED_SKILLS_DETAILS);
	return loadedSkills(stretches.flat(), recorded.filter(isLoadedSkill));
}

/** The Recovery line naming `skills`, or none. */
export function loadedSkillsLines(skills: readonly LoadedSkill[]): string[] {
	if (skills.length === 0) return [];
	const named = skills.map((skill) => `${skill.name} (${homeTilde(skill.location)})`).join(", ");
	return [renderInstruction("notices/recovery/loaded-skills.md", { skills: named })];
}
