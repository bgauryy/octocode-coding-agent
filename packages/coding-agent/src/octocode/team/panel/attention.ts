import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import type { Need } from "./state.ts";

/**
 * Waiting agents: `parent` for messages awaiting this session's agent; `ask` or `approval` only for a host's pending
 * user dialog. A dialog outranks a message. The newest message and count stay available for the panel.
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
		needs.set(message.from, {
			kind: "parent",
			message: newest ? known.message : message,
			count: (known?.count ?? 0) + 1,
		});
	}
	for (const member of members) {
		if (!member.waiting) continue;
		const known = needs.get(member.id);
		// An approval dialog outranks a question; the question's message and count stay.
		if (!known) needs.set(member.id, { kind: member.waiting === "approval" ? "approval" : "ask", count: 1 });
		else known.kind = member.waiting === "approval" ? "approval" : "ask";
	}
	return needs;
}
