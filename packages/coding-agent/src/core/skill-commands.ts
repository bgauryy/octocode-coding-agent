import type { Skill } from "./skills.ts";
import { BUILTIN_SLASH_COMMANDS } from "./slash-commands.ts";

interface SkillCommandReservation {
	name: string;
	invocationName?: string;
	aliases?: readonly string[];
}

interface SkillCommand {
	skill: Skill;
	name: string;
	qualifiedName: string;
	aliases: string[];
}

export function getSkillCommands(
	skills: readonly Skill[],
	reservedCommands: readonly SkillCommandReservation[] = [],
): SkillCommand[] {
	skills = skills.filter(skill => skill.userInvocable !== false);
	const reserved = new Set<string>();
	for (const command of [...BUILTIN_SLASH_COMMANDS, ...reservedCommands] as SkillCommandReservation[]) {
		reserved.add(command.name);
		if (command.invocationName) reserved.add(command.invocationName);
		for (const alias of command.aliases ?? []) {
			reserved.add(alias);
			reserved.add(alias.replace(/:\d+$/, ""));
		}
	}
	const counts = new Map<string, number>();
	for (const skill of skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
	const occurrences = new Map<string, number>();
	return skills.map((skill) => {
		const occurrence = (occurrences.get(skill.name) ?? 0) + 1;
		occurrences.set(skill.name, occurrence);
		const duplicate = counts.get(skill.name)! > 1;
		const qualifiedName = `skill:${skill.name}${duplicate ? `:${occurrence}` : ""}`;
		return {
			skill,
			name: duplicate || reserved.has(skill.name) ? qualifiedName : skill.name,
			qualifiedName,
			aliases: !duplicate && !reserved.has(skill.name) ? [qualifiedName] : [],
		};
	});
}
