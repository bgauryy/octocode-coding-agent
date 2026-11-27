import type { Skill } from "./skills.ts";
import { type CommandReservation, reservedCommandNames } from "./slash-commands.ts";

interface SkillCommand {
	skill: Skill;
	name: string;
}

export function getSkillCommands(
	allSkills: readonly Skill[],
	reservedCommands: readonly CommandReservation[] = [],
): SkillCommand[] {
	const skills = allSkills.filter((skill) => skill.userInvocable !== false);
	const reserved = reservedCommandNames(reservedCommands);
	const counts = new Map<string, number>();
	for (const skill of skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
	const occurrences = new Map<string, number>();
	return skills.map((skill) => {
		const occurrence = (occurrences.get(skill.name) ?? 0) + 1;
		occurrences.set(skill.name, occurrence);
		const duplicate = counts.get(skill.name)! > 1;
		const qualifiedName = `skill:${skill.name}${duplicate ? `:${occurrence}` : ""}`;
		return { skill, name: duplicate || reserved.has(skill.name) ? qualifiedName : skill.name };
	});
}
