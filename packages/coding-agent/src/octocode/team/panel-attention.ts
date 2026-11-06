import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import type { Need } from "./panel-state.ts";

/**
 * The agents that wait for the user, from what the team view already carries: a member whose `waiting` field says it waits
 * (set by the host that shows the dialog), and a member with a question to this session still
 * `awaiting reply`. The newest question names the reply command; `count` says how many wait.
 */
export function needsYou(members: Member[], traffic: Traffic[], selfId: string | undefined): Map<string, Need> {
	const needs = new Map<string, Need>();
	if (!selfId) return needs;
	for (const message of traffic) {
		if (message.from === selfId || !message.to.includes(selfId) || message.state !== "awaiting reply") continue;
		const known = needs.get(message.from);
		const newest =
			known?.message &&
			(known.message.at > message.at || (known.message.at === message.at && known.message.id > message.id));
		needs.set(message.from, { kind: "ask", message: newest ? known.message : message, count: (known?.count ?? 0) + 1 });
	}
	for (const member of members)
		if (member.waiting && !needs.has(member.id))
			needs.set(member.id, { kind: member.waiting === "approval" ? "approval" : "ask", count: 1 });
	return needs;
}
