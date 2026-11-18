import type { Member } from "@octocodeai/octocode-contracts/team";
import { memberWorktree } from "../../worktree-paths/member-worktree.ts";
import { FINISHED_MS, type Finished } from "./compact.ts";
import { type Need, type PanelEntry, panelState } from "./state.ts";

/** An agent whose heartbeat (every 5 s) stopped this long ago is killed or hung: it leaves the panel. */
const UNRESPONSIVE_MS = 15_000;

/**
 * This session's own subagents, transitively (children, grandchildren, ...). The team database is shared by every
 * Octocode process in the repository, so other sessions and their subagents are left out of this session's panel.
 */
export function descendants(members: Member[], selfId: string | undefined): Member[] {
	if (!selfId) return [];
	const children = new Map<string, { member: Member; index: number }[]>();
	members.forEach((member, index) => {
		if (!member.parentId) return;
		const siblings = children.get(member.parentId) ?? [];
		siblings.push({ member, index });
		children.set(member.parentId, siblings);
	});
	const mine = new Set([selfId]);
	const result: { member: Member; index: number; pass: number }[] = [];
	const pending = (children.get(selfId) ?? []).map((entry) => ({ ...entry, pass: 0 }));
	for (let i = 0; i < pending.length; i++) {
		const entry = pending[i];
		if (mine.has(entry.member.id)) continue;
		mine.add(entry.member.id);
		result.push(entry);
		for (const child of children.get(entry.member.id) ?? [])
			pending.push({ ...child, pass: entry.pass + Number(child.index < entry.index) });
	}
	// Match the old source-order passes even when a child precedes its parent in the team snapshot.
	return result.sort((a, b) => a.pass - b.pass || a.index - b.index).map((entry) => entry.member);
}

/** Lower sorts first: what waits for the user, then failures, then working, idle, and the rest that finished. */
function rank(entry: PanelEntry, now: number): number {
	switch (panelState(entry, now).label) {
		case "needs you":
		case "asks parent":
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
	const children = new Map<string, Member[]>();
	for (const member of members) {
		if (!member.parentId) continue;
		const siblings = children.get(member.parentId) ?? [];
		siblings.push(member);
		children.set(member.parentId, siblings);
	}
	const entries = new Map<string, PanelEntry>();
	const pending = (children.get(selfId) ?? []).map((member) => ({ member, depth: 0 })).reverse();
	while (pending.length > 0) {
		const { member, depth } = pending.pop()!;
		if (member.id === selfId || entries.has(member.id)) continue;
		entries.set(member.id, { member, depth, ...extras(member) });
		for (const child of [...(children.get(member.id) ?? [])].reverse())
			pending.push({ member: child, depth: depth + 1 });
	}
	const urgency = new Map([...entries].map(([id, entry]) => [id, rank(entry, now)]));
	// Children were discovered after parents. Folding backwards gives each branch its most urgent descendant.
	for (const entry of [...entries.values()].reverse()) {
		const parent = entry.member.parentId;
		if (parent && parent !== selfId && urgency.has(parent))
			urgency.set(parent, Math.min(urgency.get(parent)!, urgency.get(entry.member.id)!));
	}
	const ordered = (parent: string): Member[] =>
		(children.get(parent) ?? [])
			.filter((member) => entries.get(member.id)?.member === member)
			.sort((a, b) => urgency.get(a.id)! - urgency.get(b.id)! || a.joinedAt - b.joinedAt);
	const out: PanelEntry[] = [];
	const visited = new Set([selfId]);
	const stack = ordered(selfId).reverse();
	while (stack.length > 0) {
		const member = stack.pop()!;
		if (visited.has(member.id)) continue;
		visited.add(member.id);
		out.push(entries.get(member.id)!);
		for (const child of ordered(member.id).reverse()) stack.push(child);
	}
	return out;
}

/** A killed or hung agent stops its heartbeat: leave it out (the store drops it for good once its process is gone). */
export function liveMembers(members: Member[], now: number): Member[] {
	return members.filter((member) => now - member.updatedAt <= UNRESPONSIVE_MS);
}

/**
 * The other main sessions working in this session's checkout: live rows with no parent, oldest first. Worktrees of one
 * repository share the team database, so a session in another worktree (another `checkout`) is left out, and with no
 * checkout of its own this session shows none.
 */
export function peers(members: Member[], selfId: string | undefined, now: number): Member[] {
	const home = members.find((member) => member.id === selfId)?.checkout;
	if (!home) return [];
	return liveMembers(members, now)
		.filter((member) => !member.parentId && member.id !== selfId && member.checkout === home)
		.sort((a, b) => a.joinedAt - b.joinedAt);
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
	const liveIds = new Set(live.map((member) => member.id));
	const gone = finished.filter((entry) => doneAt.has(entry.member.id) && !liveIds.has(entry.member.id));
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
