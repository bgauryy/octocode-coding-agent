import { type Db, type agentEvents, agents, deliveries, leases } from "../../../../../db/src/api.ts";
import { sameProcess } from "../../shared/process.ts";
import { type Lease, toMember } from "../model.ts";
import { STALE_MS, stale } from "./limits.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

/** The process a member row names: the pid and, where known, its start time, so a reused pid is not taken for it. */
export type ProcessIdentity = agents.ProcessIdentity;

const sameIdentity = (a: ProcessIdentity, b: ProcessIdentity): boolean =>
	a.pid === b.pid && (a.started ?? null) === (b.started ?? null);

/**
 * Deletes the row, releases the leases and dead-letters the unread mail of `id`, its read but unanswered
 * `replyRequired` questions, and the relay requests it took but never settled, so their senders are told; the one
 * place a member is dropped.
 */
function retire(db: Db, id: string, now: number, reason: string): void {
	// Its open questions close too, unless a live parent may still resume it with the answer (a lingering subagent).
	deliveries.closeAsksOf(db, id, now);
	agents.remove(db, id, reason, now);
	leases.releaseByOwner(db, id);
	deliveries.deadLetterOf(db, id, now);
}

/**
 * `join`'s write, run in its transaction: takes the name unless a running process other than this one holds it. A row
 * naming `parent` is one the parent holds for this child with its reservations (`ChildLeases`): the child takes it over
 * and the reservations stay.
 */
export function claimMember(
	db: Db,
	team: string,
	workspace: agents.MemberWorkspace,
	member: Member,
	context?: agentEvents.LifecycleContext,
	parent?: ProcessIdentity,
): boolean {
	if (agents.insert(db, team, workspace, member, context) || agents.refresh(db, member, workspace, context))
		return true;
	const holder = agents.processOf(db, member.id);
	if (holder && parent && sameIdentity(holder, parent)) {
		agents.setProcess(db, member.id, member);
		return agents.refresh(db, member, workspace, context);
	}
	if (holder && sameProcess(holder.pid, holder.started)) return false;
	retire(db, member.id, Date.now(), "replaced dead registration");
	return agents.insert(db, team, workspace, member, context);
}

/** Refresh or restore presence; the caller owns its write transaction. */
export function saveMember(
	db: Db,
	team: string,
	workspace: agents.MemberWorkspace,
	member: Member,
	context?: agentEvents.LifecycleContext,
): boolean {
	return agents.refresh(db, member, workspace, context) || agents.insert(db, team, workspace, member, context);
}

/** Retires `id` unless its row now names another process than `owner` (`TeamStore.remove`); whether it did. */
export function retireOwned(db: Db, id: string, now: number, owner: ProcessIdentity | undefined): boolean {
	if (owner) {
		const row = agents.processOf(db, id);
		if (row && !sameIdentity(row, owner)) return false;
	}
	retire(db, id, now, "left");
	return true;
}

/** Retires `id` if its row still names `judged` (`TeamStore.reap`); whether it did. */
export function reapMember(db: Db, id: string, judged: ProcessIdentity | undefined, now: number): boolean {
	const row = agents.processOf(db, id);
	if (row && (judged === undefined || !sameIdentity(row, judged))) return false;
	retire(db, id, now, "reaped");
	return true;
}

/** Members still live at `since` (by heartbeat) get a fresh start from `now` (`TeamStore.resume`). */
export function resumeMembers(db: Db, team: string, since: number, now: number): void {
	agents.touchSeenSince(db, team, since - STALE_MS, now);
}

/**
 * The visible members of `team` (`TeamStore.list`), those of every worktree: the agent rows are read first, then the
 * live leases (`readLeases`), whose paths each member holds are added as its `locks` (relative to its own checkout).
 * With `stalled`, only the hidden ones whose process runs but who have not been seen for `STALE_MS`, without locks: a
 * name still reaches them (`resolveTarget`).
 */
export function listMembers(db: Db, team: string, now: number, readLeases: () => Lease[], stalled = false): Member[] {
	const live = agents
		.inTeam(db, team)
		.map(toMember)
		.filter((member) => stale(member.updatedAt, now) === stalled && sameProcess(member.pid, member.started, now));
	if (stalled) return live;
	const held = readLeases();
	return live.map((member) => {
		const locks = held
			.filter((lease) => lease.owner === member.id)
			.map((lease) => (lease.kind === "tree" ? `${lease.path}/` : lease.path));
		return locks.length > 0 ? { ...member, locks } : member;
	});
}

/** Ids of `team`'s agents whose process runs (`TeamStore.reachable`). */
export function reachableMembers(db: Db, team: string): Set<string> {
	const now = Date.now();
	return new Set(
		agents
			.processes(db, team)
			.filter((each) => sameProcess(each.pid, each.started, now))
			.map((each) => each.id),
	);
}
