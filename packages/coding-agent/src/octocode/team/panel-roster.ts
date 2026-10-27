import type { Member } from "@octocodeai/octocode-contacts/team";
import { FINISHED_MS, type Finished } from "./panel-compact.ts";
import type { PanelEntry } from "./panel-state.ts";

/** An agent whose heartbeat (every 5 s) stopped this long ago is killed or hung: it leaves the panel. */
const UNRESPONSIVE_MS = 15_000;

/**
 * This session's own subagents, transitively (children, grandchildren, ...). The team database is shared by every
 * Octocode process in the repository, so other sessions and their subagents are left out of this session's panel.
 */
export function descendants(members: Member[], selfId: string | undefined): Member[] {
	if (!selfId) return [];
	const mine = new Set([selfId]);
	const result: Member[] = [];
	let grew = true;
	while (grew) {
		grew = false;
		for (const member of members) {
			if (member.parentId && mine.has(member.parentId) && !mine.has(member.id)) {
				mine.add(member.id);
				result.push(member);
				grew = true;
			}
		}
	}
	return result;
}

/** Parents before their children, working agents first and finished ones last among siblings, each with its depth under this session. */
function treeOrder(members: Member[], selfId: string, doneAt: Map<string, number>): PanelEntry[] {
	const out: PanelEntry[] = [];
	const rank = (member: Member) => (doneAt.has(member.id) ? 2 : member.status === "working" ? 0 : 1);
	const visit = (parent: string, depth: number) => {
		const children = members
			.filter((member) => member.parentId === parent)
			.sort((a, b) => rank(a) - rank(b) || a.joinedAt - b.joinedAt);
		for (const member of children) {
			const at = doneAt.get(member.id);
			out.push({ member, depth, ...(at === undefined ? {} : { doneAt: at }) });
			visit(member.id, depth + 1);
		}
	};
	visit(selfId, 0);
	return out;
}

/** A killed or hung agent stops its heartbeat: leave it out (the store drops it for good once its process is gone). */
export function liveMembers(members: Member[], now: number): Member[] {
	return members.filter((member) => now - member.updatedAt <= UNRESPONSIVE_MS);
}

/** The agents of this session the panel shows at `now`: `others` in team order, and `tree` with depth and finish time. */
export function roster(
	members: Member[],
	selfId: string | undefined,
	now: number,
	finished: Finished[],
): { others: Member[]; tree: PanelEntry[]; doneAt: Map<string, number> } {
	const doneAt = new Map(
		finished.filter((entry) => now - entry.at <= FINISHED_MS).map((entry) => [entry.member.id, entry.at]),
	);
	const live = liveMembers(members, now);
	const gone = finished.filter((entry) => doneAt.has(entry.member.id) && !live.some((m) => m.id === entry.member.id));
	const others = descendants([...live, ...gone.map((entry) => entry.member)], selfId);
	return { others, tree: selfId ? treeOrder(others, selfId, doneAt) : [], doneAt };
}
