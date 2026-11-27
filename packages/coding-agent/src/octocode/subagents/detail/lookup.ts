import type { Member } from "@octocodeai/octocode-contracts/team";

/** The live agent `name` means: the exact id, else the one id it starts. An unknown or ambiguous name says what exists. */
export function findMember(members: readonly Member[], name: string): { member: Member } | { error: string } {
	const wanted = name.trim();
	const exact = members.find((member) => member.id === wanted);
	if (exact) return { member: exact };
	const ids = members.map((member) => member.id);
	const starts = wanted ? members.filter((member) => member.id.startsWith(wanted)) : [];
	if (starts.length === 1) return { member: starts[0] };
	const candidates = ids.length > 0 ? ` Agents: ${ids.join(", ")}` : " No agents are running.";
	return {
		error:
			starts.length > 1
				? `"${wanted}" matches ${starts.map((member) => member.id).join(", ")}: name one.`
				: `No agent "${wanted}".${candidates}`,
	};
}
