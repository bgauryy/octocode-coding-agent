import { type AgentDb, type Db, type agentEvents, agents, deliveries, leases } from "../../../../../db/src/api.ts";
import { liveProcess, sameProcess } from "../../shared/process.ts";
import { type Lease, toMember } from "../model.ts";
import { STALE_MS, stale } from "./limits.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { memberPlacement } from "./place.ts";

/** The process a member row names: the pid and, where known, its start time, so a reused pid is not taken for it. */
export type ProcessIdentity = agents.ProcessIdentity;

/**
 * Whether a member row's process still runs, never running `ps` on this thread (`liveProcess`): the team's ticker and
 * sweep ask it every second. A heartbeat within `STALE_MS` vouches for the process it names, so such a row costs no new
 * process table either: only what the shared table already shows can retire it.
 */
export const rowLive = (row: ProcessIdentity & { seenAt: number }, now: number): boolean =>
	liveProcess(row.pid, row.started, now, stale(row.seenAt, now));

const sameIdentity = (a: ProcessIdentity, b: ProcessIdentity): boolean =>
	a.pid === b.pid && (a.started ?? null) === (b.started ?? null);

export function ownsMember(db: Db, member: Member): boolean {
	const held = agents.processOf(db, member.id);
	return held !== undefined && sameIdentity(held, member);
}

/**
 * Deletes the row, releases the leases and dead-letters the unread mail of `id`, its read but unanswered
 * `replyRequired` questions, and the relay requests it took but never settled, so their senders are told; the one
 * place a member is dropped. `reason` is the writer's own; without one the row's `end_hint` or `end.fallback` decides.
 */
function retire(db: Db, id: string, now: number, reason: string | undefined, end: agents.EndInfo): void {
	// Its open questions close too, unless a live parent may still resume it with the answer (a lingering subagent).
	deliveries.closeAsksOf(db, id, now);
	agents.remove(db, id, reason, now, end);
	leases.releaseByOwner(db, id);
	deliveries.deadLetterOf(db, id, now);
}

/** Check liveness outside the write lock, then validate that identity before running the mutation once. */
export function memberTransaction<T>(agent: AgentDb, member: Member | undefined, work: (held: boolean) => T): T {
	if (member) agents.ensureMailbox(agent.db);
	if (!member) return agent.transaction(() => work(false));
	for (;;) {
		const observed = agents.processOf(agent.db, member.id);
		const held = !!observed && !sameIdentity(observed, member) && sameProcess(observed.pid, observed.started);
		const outcome = agent.transaction(() => {
			const current = agents.processOf(agent.db, member.id);
			if (current ? !observed || !sameIdentity(current, observed) : observed) return undefined;
			return { value: work(held) };
		});
		if (outcome) return outcome.value;
	}
}

/** Claim inside memberTransaction, using its checked process verdict. */
export function claimMember(
	db: Db,
	team: string,
	workspace: agents.MemberWorkspace,
	member: Member,
	held: boolean,
	context?: agentEvents.LifecycleContext,
	parent?: ProcessIdentity,
): boolean {
	const placed = memberPlacement(workspace, member);
	if (agents.insert(db, team, placed, member, context) || agents.refresh(db, member, placed, context)) return true;
	const holder = agents.processOf(db, member.id);
	// The parent holds this child's name and reservations until the child takes over.
	if (holder && parent && sameIdentity(holder, parent)) {
		agents.setProcess(db, member.id, member);
		return agents.refresh(db, member, placed, context);
	}
	if (holder && held) return false;
	retire(db, member.id, Date.now(), undefined, { fallback: "crashed", detail: "replaced dead registration" });
	return agents.insert(db, team, placed, member, context);
}

/** Refresh or restore presence; the caller owns its write transaction. */
export function saveMember(
	db: Db,
	team: string,
	workspace: agents.MemberWorkspace,
	member: Member,
	context?: agentEvents.LifecycleContext,
): boolean {
	const placed = memberPlacement(workspace, member);
	return agents.refresh(db, member, placed, context) || agents.insert(db, team, placed, member, context);
}

/** Retires `id` unless its row now names another process than `owner` (`TeamStore.remove`), with the leaver's `reason` when it knows one; whether it did. */
export function retireOwned(
	db: Db,
	id: string,
	now: number,
	owner: ProcessIdentity | undefined,
	reason?: agentEvents.EndReason,
): boolean {
	if (owner) {
		const row = agents.processOf(db, id);
		if (row && !sameIdentity(row, owner)) return false;
	}
	retire(db, id, now, reason, { fallback: "left" });
	return true;
}

/** Retires `id` if its row still names `judged` (`TeamStore.reap`); whether it did. */
export function reapMember(db: Db, id: string, judged: ProcessIdentity | undefined, now: number): boolean {
	const row = agents.processOf(db, id);
	if (row && (judged === undefined || !sameIdentity(row, judged))) return false;
	retire(db, id, now, undefined, { fallback: "crashed" });
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
		.filter(
			(member) => stale(member.updatedAt, now) === stalled && rowLive({ ...member, seenAt: member.updatedAt }, now),
		);
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
			.filter((each) => rowLive(each, now))
			.map((each) => each.id),
	);
}
