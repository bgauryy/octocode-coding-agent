import type { Member } from "./model.ts";

/** Words that carry no topic: a shared one says nothing about two goals overlapping. */
const STOP_WORDS = new Set(
	(
		"a an and or but nor the of for to in on at by with from into onto via per as is are be it its this that these those " +
		"all any some each every no not new old more less than then so up out over under about across vs etc"
	).split(" "),
);

/** Shared topic words two goals need, and the share of the shorter goal's words they must make up, to count as similar. */
const MIN_SHARED = 2;
const MIN_SHARE = 0.5;

/** A goal's topic words: lower case, without stop words, a plural `s`/`es` dropped (`fixes` and `fix` match). */
export function goalWords(goal: string): Set<string> {
	const words = goal.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	return new Set(
		words
			.filter((word) => word.length > 1 && !STOP_WORDS.has(word))
			.map((word) => (word.length > 4 ? word.replace(/(?:xes|ses|ches|shes)$/, (end) => end.slice(0, -2)) : word))
			.map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word)),
	);
}

/** Whether two goals share enough topic words: at least two, and at least half of the shorter goal's words. */
export function similarGoals(a: string, b: string): boolean {
	const left = goalWords(a);
	const right = goalWords(b);
	const shared = [...left].filter((word) => right.has(word)).length;
	return shared >= MIN_SHARED && shared / Math.min(left.size, right.size) >= MIN_SHARE;
}

/** The main session an agent runs under: itself when it is one, else its farthest live ancestor. */
function rootSession(member: Member, byId: Map<string, Member>): string | undefined {
	let current = member;
	const seen = new Set<string>([member.id]);
	while (current.parentId && byId.has(current.parentId) && !seen.has(current.parentId)) {
		current = byId.get(current.parentId)!;
		seen.add(current.id);
	}
	return current.id === member.id ? undefined : current.id;
}

/**
 * The advisory line for a task starting with `goal`: live agents of this workspace (`members`) already pursuing a
 * similar goal, or "" when none. `self` (the launching agent, its ancestors and the new child) is never named, and a
 * pair already named once (`warned`: live agent and goal) is not named again. Nothing is blocked.
 */
export function overlapNote(
	goal: string,
	members: readonly Member[],
	self: Iterable<string>,
	warned: Set<string>,
): string {
	const skip = new Set(self);
	const byId = new Map(members.map((member) => [member.id, member]));
	const key = [...goalWords(goal)].sort().join(" ");
	const similar = members.filter((member) => {
		if (skip.has(member.id) || !member.goal || !similarGoals(goal, member.goal)) return false;
		const pair = `${member.id}\u0000${key}`;
		if (warned.has(pair)) return false;
		warned.add(pair);
		return true;
	});
	if (similar.length === 0) return "";
	const named = similar.map((member) => {
		const root = rootSession(member, byId);
		return `${member.id} (${member.goal})${root ? ` in session ${root}` : ""}`;
	});
	return `Similar goal already running: ${named.join("; ")}.`;
}

/**
 * The launch result's advisory paragraph for child `child` of agent `selfId` starting with `goal` (empty when none, or when
 * the team cannot be read: an advisory never fails a launch).
 */
export function launchOverlap(
	team: { id: string | undefined; members(): Member[] },
	child: string,
	goal: string,
	warned: Set<string>,
): string {
	try {
		const members = team.members();
		const note = overlapNote(goal, members, [child, ...selfAndAncestors(team.id, members)], warned);
		return note ? `\n\n${note}` : "";
	} catch {
		return "";
	}
}

/** The launching agent and its live ancestors: their goals naturally resemble their children's. */
export function selfAndAncestors(selfId: string | undefined, members: readonly Member[]): string[] {
	if (!selfId) return [];
	const byId = new Map(members.map((member) => [member.id, member]));
	const out = [selfId];
	let parent = byId.get(selfId)?.parentId;
	while (parent && !out.includes(parent)) {
		out.push(parent);
		parent = byId.get(parent)?.parentId;
	}
	return out;
}
