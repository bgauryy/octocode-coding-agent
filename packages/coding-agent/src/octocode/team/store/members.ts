import { type Db, agents, deliveries, leases } from "../../agentdb/api.ts";
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
function retire(db: Db, id: string, now: number): void {
	agents.remove(db, id);
	leases.releaseByOwner(db, id);
	deliveries.deadLetterOf(db, id, now);
}

/** `join`'s write, run in its transaction: takes the name unless a running process other than this one holds it. */
export function claimMember(db: Db, team: string, checkout: string, member: Member): boolean {
	if (agents.insert(db, team, checkout, member) || agents.refresh(db, member, checkout)) return true;
	const holder = agents.processOf(db, member.id);
	if (holder && sameProcess(holder.pid, holder.started)) return false;
	retire(db, member.id, Date.now());
	return agents.insert(db, team, checkout, member);
}

/** Retires `id` unless its row now names another process than `owner` (`TeamStore.remove`); whether it did. */
export function retireOwned(db: Db, id: string, now: number, owner: ProcessIdentity | undefined): boolean {
	if (owner) {
		const row = agents.processOf(db, id);
		if (row && !sameIdentity(row, owner)) return false;
	}
	retire(db, id, now);
	return true;
}

/** Retires `id` if its row still names `judged` (`TeamStore.reap`); whether it did. */
export function reapMember(db: Db, id: string, judged: ProcessIdentity | undefined, now: number): boolean {
	const row = agents.processOf(db, id);
	if (row && (judged === undefined || !sameIdentity(row, judged))) return false;
	retire(db, id, now);
	return true;
}

/** Members still live at `since` (by heartbeat) get a fresh start from `now` (`TeamStore.resume`). */
export function resumeMembers(db: Db, team: string, since: number, now: number): void {
	agents.touchSeenSince(db, team, since - STALE_MS, now);
}

/**
 * The visible members of `team` (`TeamStore.list`), those of every worktree: the agent rows are read first, then the
 * live leases (`readLeases`), whose paths each member holds are added as its `locks` (relative to its own checkout).
 */
export function listMembers(db: Db, team: string, now: number, readLeases: () => Lease[]): Member[] {
	const live = agents
		.inTeam(db, team)
		.map(toMember)
		.filter((member) => !stale(member.updatedAt, now) && sameProcess(member.pid, member.started, now));
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
