import type { Member } from "@octocodeai/octocode-contracts/team";
import { memberWorktree } from "../worktree-paths/member-worktree.ts";
import { FINISHED_MS, type Finished } from "./panel-compact.ts";
import { type Need, type PanelEntry, panelState } from "./panel-state.ts";

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

/** Lower sorts first: what waits for the user, then failures, then working, idle, and the rest that finished. */
function rank(entry: PanelEntry, now: number): number {
	switch (panelState(entry, now).label) {
		case "needs you":
		case "blocked":
			return 0;
		case "failed":
			return 1;
		case "working":
			return 2;
		case "idle":
			return 3;
		default:
			return 4;
	}
}

/**
 * Parents before their children, each with its depth under this session. Siblings sort by the most urgent row in their
 * branch, so an agent that needs the user (or one of its children does) comes first, then failures, working, idle and
 * finished ones.
 */
function treeOrder(
	members: Member[],
	selfId: string,
	now: number,
	extras: (member: Member) => Omit<PanelEntry, "member" | "depth">,
): PanelEntry[] {
	const entry = (member: Member, depth: number): PanelEntry => ({ member, depth, ...extras(member) });
	const urgency = new Map<string, number>();
	const branch = (member: Member): number => {
		const known = urgency.get(member.id);
		if (known !== undefined) return known;
		const best = Math.min(
			rank(entry(member, 0), now),
			...members.filter((child) => child.parentId === member.id).map(branch),
		);
		urgency.set(member.id, best);
		return best;
	};
	const out: PanelEntry[] = [];
	const visit = (parent: string, depth: number) => {
		const children = members
			.filter((member) => member.parentId === parent)
			.sort((a, b) => branch(a) - branch(b) || a.joinedAt - b.joinedAt);
		for (const member of children) {
			out.push(entry(member, depth));
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
	/** Agents that wait for the user, by id (`needsYou`). */
	needs: ReadonlyMap<string, Need> = new Map(),
): { others: Member[]; tree: PanelEntry[]; doneAt: Map<string, number> } {
	const doneAt = new Map(
		finished.filter((entry) => now - entry.at <= FINISHED_MS).map((entry) => [entry.member.id, entry.at]),
	);
	const live = liveMembers(members, now);
	const gone = finished.filter((entry) => doneAt.has(entry.member.id) && !live.some((m) => m.id === entry.member.id));
	const others = descendants([...live, ...gone.map((entry) => entry.member)], selfId);
	const ends = new Map(finished.flatMap((entry) => (entry.end ? [[entry.member.id, entry.end] as const] : [])));
	const home = members.find((member) => member.id === selfId)?.checkout;
	const extras = (member: Member): Omit<PanelEntry, "member" | "depth"> => {
		const at = doneAt.get(member.id);
		const end = ends.get(member.id);
		const need = needs.get(member.id);
		const folder = home ? memberWorktree(member, home) : undefined;
		return {
			...(at === undefined ? {} : { doneAt: at }),
			...(at !== undefined && end ? { end } : {}),
			...(at === undefined && need ? { need } : {}),
			...(folder ? { isolated: { folder } } : {}),
		};
	};
	return { others, tree: selfId ? treeOrder(others, selfId, now, extras) : [], doneAt };
}
