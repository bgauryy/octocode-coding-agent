import { type Db, agents, deliveries, leases } from "../agentdb/api.ts";
import { type AgentDb, dbStamp, openAgentDb, sharedAgentDb } from "../agentdb/db.ts";
import { agentDbPath } from "../shared/home.ts";
import { sameProcess } from "../shared/process.ts";
import type { Ask } from "./asks.ts";
import { EditLog } from "./edits.ts";
import type { DeadLetter, Lease, LeaseRequest, Message, SendOptions } from "./model.ts";
import {
	BUSY_MS,
	INBOX_BATCH_SIZE,
	isBusy,
	LEASE_MS,
	MESSAGE_RETENTION_MS,
	PRUNE_INTERVAL_MS,
	QUICK_BUSY_MS,
} from "./store/limits.ts";
import {
	claimMember,
	listMembers,
	type ProcessIdentity,
	reachableMembers,
	reapMember,
	resumeMembers,
	retireOwned,
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
import { MessageRefs } from "./store/refs.ts";
import { pathKey, teamScope, teamWorkspace } from "./store/workspace.ts";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";

/**
 * The team tables of the agent database: who works in this repository, what they say to each other, and which files
 * they have reserved. One SQLite file shared by every Octocode process on the machine (WAL, so readers never block).
 * Two scopes: the team (the repository: its git common dir, shared by every worktree) holds agents, messages and
 * deliveries, so agents in sibling worktrees see and message each other; the checkout (the worktree root) holds leases and
 * the edit log, because those name files. Entities, after the octocode-agents-communication skill:
 *   agents      one live agent; its owner rewrites the row as it works (status, tool, tokens, heartbeat)
 *   messages    immutable; may require a reply and may answer another message (replyTo)
 *   deliveries  one row per recipient: delivered when the model saw it, completed when answered, dead when the recipient left unread
 *               (the sender is told once: notified_at); `wake` says whether it may start a turn of an idle recipient
 *               (1), or also stop a busy one's current step (2, an interrupt)
 *   leases      cooperative file/tree reservations that expire unless the owner keeps renewing them
 */

export class TeamStore {
	private readonly db: Db;
	/** Who changed which file recently, in the same database. */
	readonly edits: EditLog;
	/** Stored messages used by reference: read by id, forward, resume rows and relays (`store/refs.ts`). */
	readonly refs: MessageRefs;
	private prunedAt = -Infinity;
	/** Nested `quick` calls: only the outermost restores the long busy wait. */
	private quickDepth = 0;

	private readonly agent: AgentDb;
	/** The checkout (worktree root): scopes leases, edits and the paths they name. Not the team's scope. */
	readonly workspace: string;
	/** The team (the repository's git common dir): scopes agents, messages and deliveries, whatever worktree they work in. */
	readonly team: string;
	private readonly ownsConnection: boolean;
	private constructor(
		agent: AgentDb,
		workspace: string,
		team: string,
		/** Whether `close` closes the connection: true for `open`, false for the process connection `shared` borrows. */
		ownsConnection: boolean,
	) {
		this.agent = agent;
		this.workspace = workspace;
		this.team = team;
		this.ownsConnection = ownsConnection;

		this.db = agent.db;
		this.edits = new EditLog(agent.db, workspace);
		this.refs = new MessageRefs(
			agent.db,
			team,
			(work) => this.transaction(work),
			() => this.reachable(),
		);
	}

	/** Opens its own connection to the agent database (`agentDbPath`), which checks the file is ours and adds any missing schema first. */
	static open(cwd: string, file = agentDbPath(), env: NodeJS.ProcessEnv = process.env): TeamStore {
		const agent = openAgentDb(file, env);
		try {
			const store = new TeamStore(agent, teamWorkspace(cwd, env), teamScope(cwd, env), true);
			store.housekeep();
			return store;
		} catch (error) {
			agent.close();
			throw error;
		}
	}

	/** The team over the process's one agent database connection (`sharedAgentDb`), which sessions, memory and backlog use too. */
	static shared(cwd: string, env: NodeJS.ProcessEnv = process.env): TeamStore {
		const store = new TeamStore(sharedAgentDb(env), teamWorkspace(cwd, env), teamScope(cwd, env), false);
		store.housekeep();
		return store;
	}

	/** Closes a connection `open` made; a `shared` store leaves the process connection open. */
	close(): void {
		if (this.ownsConnection) this.agent.close();
	}

	private transaction<T>(work: () => T): T {
		return this.agent.transaction(work);
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

	/**
	 * The prune when a store opens: housekeeping, so it never makes the open fail or wait. While another process holds
	 * the write lock (many Octocode processes starting at once) it is skipped, and the next heartbeat's prune does it.
	 */
	private housekeep(): void {
		try {
			this.quick(() => this.prune());
		} catch (error) {
			if (!isBusy(error)) throw error;
		}
	}

	private prune(now = Date.now()): void {
		if (now - this.prunedAt < PRUNE_INTERVAL_MS) return;
		deliveries.pruneMessages(this.db, now - MESSAGE_RETENTION_MS);
		leases.pruneExpired(this.db, now);
		this.edits.prune(now);
		this.sweep(now);
		this.prunedAt = now;
	}

	// ── agents ────────────────────────────────────────────────────────────────

	/**
	 * Heartbeat: refreshes the member row and runs the periodic prune (at most once a minute). The row is matched by id,
	 * pid and start time, so a process never writes over a row another process holds; a row that is gone (swept while
	 * this process was stalled) is inserted again. False when another process holds the id.
	 */
	save(member: Member): boolean {
		this.prune(member.updatedAt);
		return agents.refresh(this.db, member, this.workspace) || agents.insert(this.db, this.team, this.workspace, member);
	}

	/**
	 * Takes the name `member.id` in one write transaction. False when another running process holds it: the caller
	 * draws another name. A row of this same process (a second join) is refreshed; one whose process is gone is
	 * retired first (its unread mail becomes dead letters) and the name is taken over.
	 */
	join(member: Member): boolean {
		return this.transaction(() => claimMember(this.db, this.team, this.workspace, member));
	}

	/**
	 * Leave: the agent and its reservations go; the messages it never read become dead letters the sender can see. With
	 * `owner` (a process leaving its own row) nothing is removed when the row now names another process.
	 */
	remove(id: string, now = Date.now(), owner?: ProcessIdentity): boolean {
		return this.transaction(() => retireOwned(this.db, id, now, owner));
	}

	/**
	 * Retires every member whose process is gone (`sameProcess`: dead, or a later process that got its pid): the one place
	 * a member that did not leave is dropped and its unread mail dead-lettered. A stale member (alive, silent) is kept.
	 * Each is judged outside the write lock and retired only if its row still names the process judged, so a member that
	 * joined again under the same name meanwhile is left alone. What was retired is read back with `names`.
	 */
	sweep(now = Date.now()): void {
		for (const { id, ...identity } of agents.allProcesses(this.db)) {
			if (!sameProcess(identity.pid, identity.started, now)) this.reap(id, identity, now);
		}
	}

	/** Retires `id` if its row still names `judged` (or is already gone, leaving leases of a member with no row to clean). */
	private reap(id: string, judged: ProcessIdentity | undefined, now: number): boolean {
		return this.transaction(() => reapMember(this.db, id, judged, now));
	}

	/**
	 * The machine slept from `since` to `now`: no agent could heartbeat or renew. Members still live at `since` (by
	 * heartbeat) and leases not yet expired then get a fresh start from `now`, so the first process awake does not prune
	 * its sleeping peers, drop their reservations or dead-letter their messages. Idempotent: every process that wakes
	 * calls it. A member that stays silent after the wake goes `STALE_MS` later, its leases `LEASE_MS` later.
	 */
	resume(since: number, now = Date.now()): void {
		this.transaction(() => {
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
	 * left out; nothing is removed here, `sweep` and `remove` do that.
	 */
	list(now = Date.now()): Member[] {
		return listMembers(this.db, this.team, now, () => teamLeases(this.db, this.team, now));
	}

	/** Ids of this team's agents that can still read mail: every one whose process runs, stale (stalled) ones included. */
	private reachable(): Set<string> {
		return reachableMembers(this.db, this.team);
	}

	// ── messages ──────────────────────────────────────────────────────────────

	/**
	 * Store one message for every recipient that can still read it (a stalled, stale one keeps its mail). A reply
	 * completes the delivery it answers. Recipients that left or whose process ended are refused and returned in
	 * `departed`; with none left, nothing is stored and `id` is undefined.
	 * `wake` (a question, or a sender outside the team) lets it start an idle recipient's turn; otherwise only the
	 * answer to a question that recipient asked, and still awaited, wakes it. `sign` makes the recipient's `proof` once the
	 * message has its id (see `userProof`); it returns undefined for a recipient the caller cannot sign for.
	 */
	send(
		from: string,
		to: string[],
		body: string,
		options: SendOptions & { replyRequired: boolean; wake?: boolean; sign?: SignProof },
		now = Date.now(),
	): { id: number | undefined; departed: string[] } {
		// Read in the same IMMEDIATE transaction as the insert: no recipient can leave in between.
		return this.transaction(() => insertMessage(this.db, this.team, this.reachable(), from, to, body, options, now));
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
		this.transaction(() => deliveries.markNotified(this.db, letters, now));
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
		this.transaction(() => deliveries.markDelivered(this.db, id, messageIds, now));
	}

	/**
	 * The latest messages in this team, newest first, with their delivery state. The team is shared by every
	 * session in the repository, whatever its worktree, so the default fetches enough rows for a panel to filter its own and still show a few.
	 */
	recent(limit = 30, now = Date.now(), windowMs = 10 * 60_000): Traffic[] {
		return recent(this.db, this.team, limit, now, windowMs);
	}

	// ── leases ────────────────────────────────────────────────────────────────

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

	/** Retires a lease owner that is gone (it has no row, or its process died or was replaced); whether it was. */
	private retireOwner(owner: string, now: number): boolean {
		const judged = agents.processOf(this.db, owner);
		if (judged && sameProcess(judged.pid, judged.started, now)) return false;
		return this.reap(owner, judged, now);
	}

	/**
	 * Reserve every request or none: a conflict with another live lease rejects the whole set. The requests must not
	 * overlap each other (a tree and a path under it, two spellings of one path, a path twice): that is an error, as in
	 * the agents-communication package, because the caller's intent is then unclear (ask for the tree alone).
	 */
	lock(
		owner: string,
		requests: LeaseRequest[],
		now = Date.now(),
	): { ok: true; leases: Lease[] } | { ok: false; conflicts: Array<{ path: string; heldBy: Lease }> } {
		if (requests.length === 0) throw new Error("Give at least one path.");
		refuseOverlap(this.workspace, requests);
		return this.transaction(() => {
			this.prune(now);
			const conflicts = requests.flatMap((request) => {
				const heldBy = this.conflict(request.path, owner, request.kind, now);
				return heldBy ? [{ path: request.path, heldBy }] : [];
			});
			if (conflicts.length > 0) return { ok: false as const, conflicts };
			writeLeases(this.db, this.workspace, owner, requests, now);
			return { ok: true as const, leases: this.leases(now).filter((lease) => lease.owner === owner) };
		});
	}

	/**
	 * Keep the owner's reservations alive; called with every heartbeat. Leases that had already lapsed (a peer may have
	 * taken the path since) are released, not revived: the owner learns of them from `owned`, which no longer lists
	 * them, and must lock them again.
	 */
	renew(owner: string, now = Date.now()): void {
		this.transaction(() => {
			leases.dropLapsed(this.db, owner, now);
			leases.extendOwner(this.db, owner, now + LEASE_MS);
		});
		this.prune(now);
	}

	/** `kind:key` of every live lease the owner holds in this checkout. */
	owned(owner: string, now = Date.now()): Set<string> {
		return new Set(
			this.leases(now)
				.filter((lease) => lease.owner === owner)
				.map((lease) => `${lease.kind}:${pathKey(this.workspace, lease.path)}`),
		);
	}

	/** Release the owner's reservations for the given paths, or all of them; returns how many were released. */
	unlock(owner: string, paths?: string[]): number {
		return releaseLeases(this.db, this.workspace, owner, paths);
	}
}
