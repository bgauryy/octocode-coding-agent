import { registeredWorkspace } from "../../storage/workspace-database.ts";
import {
	type AgentDb,
	type agentEvents,
	type Db,
	agents,
	dbStamp,
	deliveries,
	isBusy,
	leases,
} from "../../../../db/src/api.ts";
import { openAgentDb, sharedAgentDb } from "../../storage/database.ts";
import { agentDbPath } from "../shared/home.ts";
import { processAlive } from "../shared/process.ts";
import type { Ask } from "./asks.ts";
import { EditLog } from "./edits.ts";
import type { DeadLetter, Lease, LeaseConflict, LeaseRequest, Message, SendOptions } from "./model.ts";
import { BUSY_MS, INBOX_BATCH_SIZE, LEASE_MS, PRUNE_INTERVAL_MS, QUICK_BUSY_MS } from "./store/limits.ts";
import {
	claimMember,
	memberTransaction,
	listMembers,
	type ProcessIdentity,
	reachableMembers,
	reapMember,
	resumeMembers,
	saveMember,
	settleMember,
	ownsMember,
	retireOwned,
	rowLive,
} from "./store/members.ts";
import { asks, deadLetters, insertMessage, pending, pendingUrgent, recent, type SignProof } from "./store/mail.ts";
import {
	conflictingLease,
	liveLeases,
	teamLeases,
	refuseOverlap,
	releaseLeases,
	resumeLeases,
	writeLeases,
} from "./store/leasing.ts";
import { Presence } from "./store/presence.ts";
import { MessageRefs } from "./store/refs.ts";
import { memberWorkspace, Place } from "./store/place.ts";
import { pathKey, teamScope, teamWorkspace } from "./store/workspace.ts";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";

/** Repository-wide roster and mail, with identified checkout-local edits and physical file reservations. */
export class TeamStore {
	private readonly db: Db;
	/** Who changed which file recently, in the same database. */
	readonly edits: EditLog;
	/** Stored messages used by reference: read by id, forward, resume rows and relays (`store/refs.ts`). */
	readonly refs: MessageRefs;
	/** The event cursor, this connection's own writes and the parent's end hint (`store/presence.ts`). */
	readonly presence: Presence;
	private prunedAt = -Infinity;
	/** Nested `quick` calls: only the outermost restores the long busy wait. */
	private quickDepth = 0;

	private readonly agent: AgentDb;
	/** The checkout (worktree root): scopes leases, edits and the paths they name. Not the team's scope. */
	get workspace(): string {
		return this.edits.workspace;
	}
	private readonly memberWorkspace: agents.MemberWorkspace;
	get workspaceId(): string {
		return this.memberWorkspace.id;
	}
	/** The team (the repository's git common dir): scopes agents, messages and deliveries, whatever worktree they work in. */
	readonly team: string;
	owns = (member: Member): boolean => ownsMember(this.db, member);
	private readonly ownsConnection: boolean;
	private constructor(
		agent: AgentDb,
		cwd: string,
		env: NodeJS.ProcessEnv,
		/** Whether `close` closes the connection: true for `open`, false for the process connection `shared` borrows. */
		ownsConnection: boolean,
	) {
		this.agent = agent;
		this.presence = new Presence(agent);
		const origin = registeredWorkspace(cwd, agent);
		const leaseRoot = teamWorkspace(cwd, env);
		const leaseWorkspace = leaseRoot === origin.root ? origin : registeredWorkspace(leaseRoot, agent);
		this.memberWorkspace = memberWorkspace(origin.id, leaseWorkspace.id, new Place(cwd));
		this.team = teamScope(cwd, env);
		this.ownsConnection = ownsConnection;

		this.db = agent.db;
		this.edits = new EditLog(agent.db, leaseWorkspace.id);
		this.refs = new MessageRefs(
			agent.db,
			this.team,
			this.workspaceId,
			(work) => this.agent.transaction(work),
			() => this.reachable(),
		);
	}

	/** Opens its own connection to the agent database (`agentDbPath`), which checks the file is ours and adds any missing schema first. */
	static open(cwd: string, file = agentDbPath(), env: NodeJS.ProcessEnv = process.env): TeamStore {
		const agent = openAgentDb(file, env);
		try {
			const store = new TeamStore(agent, cwd, env, true);
			store.housekeep();
			return store;
		} catch (error) {
			agent.close();
			throw error;
		}
	}

	/** The team over the process's one agent database connection (`sharedAgentDb`), which sessions, memory and backlog use too. */
	static shared(cwd: string, env: NodeJS.ProcessEnv = process.env): TeamStore {
		const store = new TeamStore(sharedAgentDb(env), cwd, env, false);
		store.housekeep();
		return store;
	}

	/** Closes a connection `open` made; a `shared` store leaves the process connection open. */
	close(): void {
		if (this.ownsConnection) this.agent.close();
	}

	/** Moves whenever any process writes the database file (`dbStamp`): equal stamps mean a read would answer as it did. */
	stamp(): string {
		return dbStamp(this.agent.file);
	}

	/** Runs background work with a short busy wait, so a database held by another process never freezes this one. */
	quick<T>(work: () => T): T {
		if (this.quickDepth++ === 0) agents.setBusyTimeout(this.db, QUICK_BUSY_MS);
		try {
			return work();
		} finally {
			if (--this.quickDepth === 0) agents.setBusyTimeout(this.db, BUSY_MS);
		}
	}

	/** The prune when a store opens: it never makes the open fail or wait; while the write lock is held elsewhere the next heartbeat's prune does it. */
	private housekeep(): void {
		try {
			this.quick(() => this.prune());
		} catch (error) {
			if (!isBusy(error)) throw error;
		}
	}

	private prune(now = Date.now()): void {
		if (now - this.prunedAt < PRUNE_INTERVAL_MS) return;
		this.refs.prune(now);
		leases.pruneExpired(this.db, now);
		this.edits.prune(now);
		this.sweep(now);
		this.presence.noteStalled(this.list(now, true), now);
		this.prunedAt = now;
	}

	lifecycle: agentEvents.LifecycleContext | undefined;

	/**
	 * Heartbeat: refreshes the member row and runs the periodic prune (at most once a minute). The row is matched by id,
	 * pid and start time, so a process never writes over a row another process holds; a row that is gone (swept while
	 * this process was stalled) is inserted again. False when another process holds the id.
	 */
	save(member: Member): boolean {
		this.prune(member.updatedAt);
		return this.agent.transaction(() => saveMember(this.db, this.team, this.memberWorkspace, member, this.lifecycle));
	}

	/**
	 * Takes the name `member.id` in one write transaction. False when another running process holds it: the caller
	 * draws again. Refreshes this process, retires dead holders with unread mail, or takes over from its parent.
	 */
	join(member: Member, from?: ProcessIdentity): boolean {
		return memberTransaction(this.agent, member, (held) =>
			claimMember(this.db, this.team, this.memberWorkspace, member, held, this.lifecycle, from),
		);
	}

	/** Leave: the agent and its reservations go; its unread messages become dead letters. With `owner`, nothing is removed when the row names another process. */
	remove(id: string, now = Date.now(), owner?: ProcessIdentity, reason?: agentEvents.EndReason): boolean {
		return this.agent.transaction(() => retireOwned(this.db, id, now, owner, reason));
	}

	/**
	 * Retires every member whose process is gone (`rowLive`: dead, or a later process that got its pid; no `ps` for a fresh
	 * heartbeat; `deadOnly`: only a pid that no longer runs, cheap enough for every heartbeat): the one place a member that
	 * did not leave is dropped and its mail dead-lettered. A stale member is kept.
	 * Each is judged outside the write lock and retired only if its row still names the process judged, so a member that
	 * joined again under the same name meanwhile is left alone. What was retired is read back with `names`.
	 */
	sweep(now = Date.now(), deadOnly = false): void {
		for (const { id, seenAt, ...identity } of agents.allProcesses(this.db))
			if (deadOnly ? !processAlive(identity.pid) : !rowLive({ ...identity, seenAt }, now)) this.reap(id, identity, now);
	}

	/** Retires `id` if its row still names `judged` (or is already gone, leaving leases of a member with no row to clean). */
	private reap(id: string, judged: ProcessIdentity | undefined, now: number): boolean {
		return this.agent.transaction(() => reapMember(this.db, id, judged, now));
	}

	/**
	 * The machine slept from `since` to `now`: no agent could heartbeat or renew. Members still live at `since` (by
	 * heartbeat) and leases not yet expired then get a fresh start from `now`, so the first process awake does not prune
	 * its sleeping peers, drop their reservations or dead-letter their messages. Idempotent: every process that wakes
	 * calls it. A member that stays silent after the wake goes `STALE_MS` later, its leases `LEASE_MS` later.
	 */
	resume(since: number, now = Date.now()): void {
		this.agent.transaction(() => {
			resumeMembers(this.db, this.team, since, now);
			resumeLeases(this.db, this.team, since, now);
		});
	}

	/** Every agent name in the shared database, whatever its team (ids are unique across all of them), live or not yet dropped. */
	names(): string[] {
		return agents.ids(this.db);
	}

	/**
	 * Visible agents of this team (every worktree of the repository), oldest first, with unanswered-message counts and held
	 * paths (relative to the member's own `checkout`). A stale one (silent for `STALE_MS`) or one whose process is gone is
	 * left out (`stalled`: only the stale ones whose process runs); nothing is removed here, `sweep` and `remove` do that.
	 */
	list(now = Date.now(), stalled = false): Member[] {
		return listMembers(this.db, this.team, now, () => teamLeases(this.db, this.team, now), stalled);
	}

	/** Ids of this team's agents that can still read mail: every one whose process runs, stale (stalled) ones included. */
	reachable(): Set<string> {
		return reachableMembers(this.db, this.team);
	}

	// ── messages ──────────────────────────────────────────────────────────────

	/**
	 * Store one message for every recipient that can still read it (a stalled, stale one keeps its mail). A reply
	 * completes the delivery it answers. Recipients that left or whose process ended are refused and returned in
	 * `departed`; with none left, nothing is stored and `id` is undefined.
	 * `wake` (a question, or a sender outside the team) lets it start an idle recipient's turn; otherwise only the
	 * answer to a question that recipient asked, and still awaited, wakes it. `woken` returns the recipients given that
	 * wake (an interrupt included), so a sender can be told how its message meets each of them. `sign` makes the recipient's `proof` once the
	 * message has its id (see `userProof`); it returns undefined for a recipient the caller cannot sign for.
	 */
	send(
		from: string,
		to: string[],
		body: string,
		options: SendOptions & { replyRequired: boolean; wake?: boolean; sign?: SignProof },
		now = Date.now(),
	): { id: number | undefined; departed: string[]; woken: string[] } {
		// Read in the same IMMEDIATE transaction as the insert: no recipient can leave in between.
		return this.agent.transaction(() =>
			insertMessage(this.db, this.team, this.workspaceId, this.reachable(), from, to, body, options, now),
		);
	}

	/** The sender of message `id` in this team and whether it asked for a reply; undefined when there is no such message. */
	replyTarget(id: number): { from: string; replyRequired: boolean } | undefined {
		return deliveries.replyTarget(this.db, this.team, id);
	}

	/**
	 * The questions `child` sent `parent` (messages with `replyRequired`) since `since`, oldest first, each with the
	 * parent's first reply to it (a message with `replyTo` that id). Read from the existing tables: nothing is stored for it.
	 */
	asks(child: string, parent: string, since: number): Ask[] {
		return asks(this.db, this.team, child, parent, since);
	}

	/** Messages `sender` sent whose recipients left before reading them, not yet reported to it (oldest first). */
	deadLetters(sender: string, limit = INBOX_BATCH_SIZE): DeadLetter[] {
		return deadLetters(this.db, this.team, sender, limit);
	}

	/** Records that the sender was told these dead letters went unread. */
	markNotified(letters: DeadLetter[], now = Date.now()): void {
		if (letters.length === 0) return;
		this.agent.transaction(() => deliveries.markNotified(this.db, letters, now));
	}

	/** How many messages newer than `after` wait undelivered for `id` (the inbox index alone): the inbox reads them only when this is non-zero. */
	waiting(id: string, after = 0): number {
		return deliveries.countWaiting(this.db, id, after);
	}

	/** The ids of the messages up to `through` that still wait undelivered for `id`: the inbox handed those over, or its mark ran ahead of this database. */
	waitingThrough(id: string, through: number): number[] {
		return deliveries.waitingIds(this.db, id, through);
	}

	/** One bounded batch of messages newer than `after` waiting for `id`, oldest first. `ack` marks the ones the model saw. */
	pending(id: string, after = 0): Message[] {
		return pending(this.db, id, after);
	}

	/** One control message can pass an unseen ordinary batch: interrupts always, waking requests while idle. */
	pendingUrgent(id: string, after: number, idle: boolean): Message | undefined {
		return pendingUrgent(this.db, id, after, idle);
	}

	/** Mark messages delivered to `id` (FYI messages are complete on delivery). One reader per recipient, so no lease. */
	ack(id: string, messageIds: number[], now = Date.now()): void {
		if (messageIds.length === 0) return;
		this.agent.transaction(() => deliveries.markDelivered(this.db, id, messageIds, now));
	}

	/**
	 * The latest messages in this team, newest first, with their delivery state. The team is shared by every
	 * session in the repository, whatever its worktree, so the default fetches enough rows for a panel to filter its own and still show a few.
	 */
	recent(limit = 30, now = Date.now(), windowMs = 10 * 60_000): Traffic[] {
		return recent(this.db, this.team, limit, now, windowMs);
	}

	/** The live leases in this checkout (paths relative to it): the ones that can conflict with this checkout's files. */
	leases(now = Date.now()): Lease[] {
		return liveLeases(this.db, this.workspace, now);
	}

	/**
	 * A live lease held by someone other than `self` that covers `file` (or, for a tree request, lies under it): in this
	 * checkout, or in a nested one of the team (a worktree under `.octocode/worktrees/` is the same files as in main).
	 */
	conflict(file: string, self: string, kind: "file" | "tree" = "file", now = Date.now()): Lease | undefined {
		return conflictingLease(this.db, this.team, this.workspace, file, self, kind, now, (owner, at) =>
			this.retireOwner(owner, at),
		);
	}

	/** A headless child's run ended while `parent` holds its leases: its row becomes `settled` under `parent`, keeping them (`settleMember`); whether it did. */
	settle(id: string, owner: ProcessIdentity, parent: ProcessIdentity, reason?: agentEvents.EndReason): boolean {
		return this.agent.transaction(() => settleMember(this.db, id, Date.now(), owner, parent, reason));
	}

	/** Retires a lease owner that is gone (no row, or `rowLive` says its process is: a fresh heartbeat vouches for a running pid); whether it was. */
	private retireOwner(owner: string, now: number): boolean {
		const judged = agents.seatOf(this.db, owner);
		if (judged && rowLive(judged, now)) return false;
		return this.reap(owner, judged, now);
	}

	/**
	 * Reserve all requests atomically. Reject overlaps between the requests or with another agent's live lease. `child`:
	 * the row this process holds for `owner`, a subagent not running yet, written with its leases (`ChildLeases`).
	 */
	lock(
		owner: string,
		requests: LeaseRequest[],
		now = Date.now(),
		child?: Member,
	): { ok: true; leases: Lease[] } | { ok: false; conflicts: LeaseConflict[] } {
		if (requests.length === 0) throw new Error("Give at least one path.");
		refuseOverlap(this.workspace, requests);
		return memberTransaction(this.agent, child, (held) => {
			this.prune(now);
			const conflicts = requests.flatMap((request) => {
				const heldBy = this.conflict(request.path, owner, request.kind, now);
				return heldBy ? [{ path: request.path, heldBy }] : [];
			});
			if (conflicts.length > 0) return { ok: false as const, conflicts };
			if (child && !claimMember(this.db, this.team, this.memberWorkspace, child, held))
				throw new Error(`The team name ${owner} is held by another running agent.`);
			writeLeases(this.db, this.workspace, this.edits.workspaceId, owner, requests, now);
			return { ok: true as const, leases: this.leases(now).filter((lease) => lease.owner === owner) };
		});
	}

	/**
	 * Keep the owner's reservations alive; called with every heartbeat. Leases that had already lapsed (a peer may have
	 * taken the path since) are released, not revived: the owner learns of them from `owned`, which no longer lists
	 * them, and must lock them again.
	 */
	renew(owner: string, now = Date.now()): void {
		this.agent.transaction(() => {
			leases.dropLapsed(this.db, owner, now);
			leases.extendOwner(this.db, owner, now + LEASE_MS);
		});
		this.prune(now);
	}

	/** `kind:key` of every live lease the owner holds in this checkout. */
	owned(owner: string, now = Date.now()): Set<string> {
		const root = this.workspace;
		return new Set(
			this.leases(now)
				.filter((lease) => lease.owner === owner)
				.map((lease) => `${lease.kind}:${pathKey(root, lease.path)}`),
		);
	}

	/** Release the owner's reservations for the given paths, or all of them; returns how many were released. */
	unlock(owner: string, paths?: string[]): number {
		return releaseLeases(this.db, this.workspace, owner, paths);
	}
}
