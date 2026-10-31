import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import { envFlag, ownNonce, SUBAGENT_ENV } from "../../../../common/src/env.ts";
import { peerDbPath, peerRegistryDir } from "../shared/home.ts";
import { interactive } from "../shared/interactive.ts";
import { terminateSelf } from "../shared/process.ts";
import { storedText } from "../../../../common/src/sanitize.ts";
import type { Ask } from "./asks.ts";
import { Delivery } from "./delivery.ts";
import type { EditLog } from "./edits.ts";
import { HeldLeases } from "./held.ts";
import { agentName, LINE_MAX } from "./identity.ts";
import { Mail } from "./mail.ts";
import type { Lease, SendOptions } from "./model.ts";
import { PeerLeases } from "./peer-leases.ts";
import { Relays } from "./relay.ts";
import { Activity, HEARTBEAT_MS } from "./session/activity.ts";
import { TeamDatabase } from "./session/database.ts";
import { claimName } from "./session/membership.ts";
import { SessionTeamName } from "./session/rejoin.ts";
import { watchParentProcess } from "./session/parent.ts";
import { lockPaths, type ReservationHost, reservationText, unlockPaths } from "./session/reservations.ts";
import * as refs from "./session/references.ts";
import { type MessageHook, type Resumer, type SendResult, sendMessage } from "./session/send.ts";
import { Vouches } from "./session/vouches.ts";
import { type TeamStore } from "./store.ts";
import { TeamTicker, type TeamView } from "./ticker.ts";
import { AGENT_ID_ENV, PARENT_ID_ENV } from "./store/env.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

/** This process's place in the team: joins, reports what it is doing, holds reservations and delivers messages sent to it. */
export class Team {
	private me: Member | undefined;
	private ctx: ExtensionContext | undefined;
	/** The team database, opened on first use (`session/database.ts`). */
	private readonly database = new TeamDatabase({ ctx: () => this.ctx, env: () => this.env });
	/** The one ticker: delivery and heartbeats while joined, a cached view for watchers (the panel). */
	private readonly ticker = new TeamTicker({
		joined: () => this.me !== undefined,
		beat: () => this.delivery.deliver(this.database.current),
		dbFile: () => this.database.watchedFile(),
		read: () => this.database.read(),
		resumed: (since, now) => this.database.resumed(since, now),
		maxAgeMs: HEARTBEAT_MS,
	});
	private readonly held = new HeldLeases();
	/** The agents-communication package's path leases (read-only), opened on the first guarded write. */
	private peers: PeerLeases | undefined;
	private readonly mail: Mail;
	private readonly delivery: Delivery;
	/** This agent's status, tool counts and usage, written with the heartbeat (`session/activity.ts`). */
	private readonly activity: Activity;
	/** Stops the check that the parent still runs (a subagent only; on from the session start, joined or not). */
	private stopParentWatch: (() => void) | undefined;
	/** Subagents this session started that have finished: id → where their report went, for a later message to them. */
	private readonly finished = new Map<string, string>();
	/** Resumes a finished subagent that still lingers (set by the subagents domain); its receipt, else undefined. */
	setResumer(resume: Resumer): void {
		this.resumer = resume;
	}
	private resumer: Resumer | undefined;
	private messageHook: MessageHook | undefined;
	setMessageHook(hook: MessageHook): void {
		this.messageHook = hook;
	}
	/** Settles children's relay requests to agents they cannot reach (B200), before mail reaches the model. */
	private readonly relays = new Relays({
		id: () => this.me?.id,
		finished: this.finished,
		started: (id) => this.finished.has(id) || this.vouches.has(id),
		resumer: () => this.resumer,
	});

	/** Recent completion receipts; active-agent limits cannot bound a long session's history. */
	rememberFinished(id: string, receipt: string): void {
		this.finished.delete(id);
		this.finished.set(id, receipt);
		if (this.finished.size > 128) this.finished.delete(this.finished.keys().next().value!);
	}
	private readonly env: NodeJS.ProcessEnv;
	private readonly name: SessionTeamName;
	constructor(api: ExtensionAPI, env: NodeJS.ProcessEnv = process.env) {
		this.env = env;
		this.name = new SessionTeamName(api, env);
		this.mail = new Mail(api, () => ownNonce(this.env));
		this.activity = new Activity({
			me: () => this.me,
			db: () => this.database.current,
			held: this.held,
			mail: this.mail,
		});
		this.delivery = new Delivery(
			{
				id: () => this.me?.id,
				parentId: () => this.parentId,
				ctx: () => this.ctx,
				headless: () => this.headless(),
				heartbeat: (db) => this.activity.heartbeat(db),
				relays: (db) => this.relays.take(db),
			},
			this.mail,
		);
	}
	private readonly vouches = new Vouches();
	/**
	 * Registers the secret this session gave subagent `id` (the secret in its `PERMISSION_NONCE_FILE_ENV` file), so `/agents tell` can sign for it and
	 * the child can tell the user's message from a forged one. Returns what ends it, when the child is gone.
	 */
	vouch(id: string, secret: string): () => void {
		return this.vouches.vouch(id, secret);
	}

	/** Aborted while an interrupt waits for this agent's run to stop (`agent_before_settle` waits end early on it). */
	get interrupted(): AbortSignal {
		return this.mail.interrupted;
	}

	get id(): string | undefined {
		return this.me?.id;
	}

	get parentId(): string | undefined {
		return this.env[PARENT_ID_ENV];
	}

	/** Bind to the session; join straight away in a subagent (the parent chose the id) or under the name a resumed session recorded. */
	start(ctx: ExtensionContext, resumeAs?: string): void {
		try {
			this.stop();
		} catch {
			/* the old row stays (locked or closed database) and ages out; stop() cleared the state */
		}
		this.ctx = ctx;
		this.database.clearProblem();
		this.activity.resetEarly();
		this.watchParent();
		if (this.name.start(resumeAs) || this.env[AGENT_ID_ENV]) this.join();
	}

	/**
	 * A crashed parent's child spends tokens for nobody: once the parent is gone, Octocode's SIGTERM path disposes the session
	 * and exits (ARCHITECTURE: Liveness). Its own unref'd timer, so a child that could not join the team stops too.
	 */
	private watchParent(): void {
		this.stopParentWatch ??= watchParentProcess(this.env, () => {
			this.stopParentWatch?.();
			this.stopParentWatch = undefined;
			// Where a signal ends the process outright (Windows) nothing runs after it: the row and reservations go now, not when a peer's sweep finds the pid dead.
			try {
				this.leave();
			} catch {
				/* locked database: the sweep reaps the row */
			}
			terminateSelf();
		});
	}

	/** The database opens on first use, so a session that never collaborates never creates it. */
	private store(): TeamStore {
		return this.database.store();
	}

	/** Set when the team database is foreign or too new; nothing team-related works until it is fixed. */
	get problem(): string | undefined {
		return this.database.problem;
	}

	/** A name held by no member of the shared database, finished subagent of this session or caller in `inUse` (a subagent not yet in it, or a name another process took first). */
	newName(inUse: Iterable<string> = []): string {
		let live: string[] = [];
		try {
			live = this.existing()?.names() ?? [];
		} catch {
			// An unusable database holds no names this process can read; avoid the rest.
		}
		return agentName([...live, ...this.finished.keys(), ...inUse, ...(this.me ? [this.me.id] : [])]);
	}

	/** Join (or refresh) as this process. Idempotent; `goal` replaces the one-line goal (validated by the caller with `checkGoal`, `identity.ts`). */
	join(goal?: string): Member {
		const db = this.store(); // throws before the session starts
		const ctx = this.ctx!;
		if (!this.me) {
			this.me = claimName(this.env, db, ctx, goal, (lost) => this.newName(lost), this.name);
			db.edits.adoptUnjoined(this.me.id);
			this.activity.joined(this.me);
			this.ticker.sync();
		} else if (goal !== undefined) {
			this.me.goal = storedText(goal, LINE_MAX);
		}
		this.activity.flush(db);
		return this.me;
	}

	/** Leave the team and release everything held; the database stays open for the next join. State clears first: a refused removal still throws, but leaves nothing stale (the row ages out). */
	leave(): void {
		const me = this.me;
		this.me = undefined;
		this.ticker.sync();
		this.held.clear();
		const db = this.database.current;
		this.delivery.reset(db, me?.id);
		this.mail.reset();
		// Only a row that still names this process: a name another process holds now is not ours to remove.
		if (me && db) db.remove(me.id, Date.now(), me);
	}

	/** Leave and let go of the database (session end; the process connection stays open for the next session). */
	stop(): void {
		try {
			this.leave();
		} finally {
			this.stopParentWatch?.();
			this.stopParentWatch = undefined;
			this.database.release();
			this.peers?.close();
			this.peers = undefined;
			this.ticker.reset();
			this.finished.clear();
			this.vouches.clear();
			this.ctx = undefined;
		}
	}

	/** Call `listener` on every tick with a fresh `view` (shared ticker and cache; watchers never read the database). */
	watch(listener: () => void): () => void {
		return this.ticker.watch(listener);
	}

	/** The latest snapshot the ticker read (for watchers). */
	get view(): TeamView {
		return this.ticker.view;
	}

	/**
	 * The database only if someone already created it: reads never create it, since before anyone has collaborated
	 * there is nothing to read. Throws when it exists but is unusable.
	 */
	private existing(): TeamStore | undefined {
		return this.database.existing();
	}

	/** Live agents (none when the database cannot be read; `snapshot` says why). */
	members(): Member[] {
		return this.snapshot().members;
	}

	/** Live agents and the latest messages between them, from one read. */
	snapshot(): TeamView {
		return this.database.snapshot();
	}

	/**
	 * The questions `child` sent its `parent` since `since`, with their answers. None when the database cannot be read:
	 * this is a measurement, so it never fails the run it describes.
	 */
	asks(child: string, parent: string, since: number): Ask[] {
		return this.database.asks(child, parent, since);
	}

	/** Queue a message for the agents `to` resolves to; returns who got it and the message id, or an error text. */
	async send(
		recipient: string | undefined,
		text: string,
		options: SendOptions & { from?: string | undefined; signal?: AbortSignal } = {},
	): Promise<SendResult> {
		return sendMessage(this.sendHost(), recipient, text, options);
	}

	/** Stored message `id` for `requester` (`msg#N`): its sender, a recipient, or the session that started one; else an error. */
	readMessage(id: number, requester: string): refs.StoredMessage | { error: string } {
		return refs.readMessage(this.sendHost(), id, requester);
	}
	/** Delivers stored message `id` from `by` to `to` (an id, role, "parent" or "all") without copying it (`references.ts`). */
	forwardMessage(id: number, by: string, to: string, note?: string, signal?: AbortSignal) {
		return refs.forwardMessage(this.sendHost(), id, by, to, note, signal);
	}
	/** Unanswered `replyRequired` questions agent `agentId` sent to agents other than this session (decision 6). */
	unansweredPeerAsks(agentId: string): number {
		return refs.unansweredPeerAsks(this.sendHost(), agentId);
	}

	/** The team as sending and references see it (`session/send.ts`, `session/references.ts`). */
	private sendHost(): refs.ReferenceHost {
		return {
			me: () => this.me,
			ctx: () => this.ctx,
			db: () => this.database.current,
			store: () => this.store(),
			parentId: () => this.parentId,
			finished: this.finished,
			resumer: () => this.resumer,
			messageHook: () => this.messageHook,
			signed: (id, recipient, text) => this.vouches.signed(id, recipient, text),
			started: (id) => this.finished.has(id) || this.vouches.has(id),
			mail: this.mail,
		};
	}

	/** Reserve paths (a trailing `/` marks a whole directory tree) for this agent. */
	lock(
		paths: string[],
		reason: string,
	): { ok: true; leases: Lease[]; held: number } | { ok: false; conflicts: Array<{ path: string; heldBy: Lease }> } {
		return lockPaths(this.reservationHost(), paths, reason);
	}

	unlock(paths?: string[]): number {
		return unlockPaths(this.reservationHost(), paths);
	}

	/** The team as path reservations see it (`session/reservations.ts`). */
	private reservationHost(): ReservationHost {
		return {
			me: () => this.me,
			join: () => this.join(),
			cwd: () => this.ctx?.cwd,
			store: () => this.store(),
			existing: () => this.existing(),
			held: this.held,
			// Whether this agent takes part in the team: it joined, or still tracks reservations.
			collaborating: () => this.me !== undefined || this.held.any,
			peerLeases: () => this.peerLeases(),
		};
	}

	/** The package reads its home from the process environment, so this does too (not the team's injected `env`, which only carries a subagent's identity). */
	private peerLeases(): PeerLeases {
		this.peers ??= new PeerLeases(peerDbPath(), {
			registry: peerRegistryDir(),
			self: () => this.ctx?.sessionManager.getSessionId(),
			warn: (text) => this.mail.notice(text),
		});
		return this.peers;
	}

	/** Why the file may not be changed (another agent's reservation, in this team or in agents-communication; our lapsed one; or an unreadable team database), or undefined; with no file, any reservation another agent holds. */
	reservation(absolute: string | undefined, display: string): string | undefined {
		return reservationText(this.reservationHost(), absolute, display);
	}

	/** Who changed which file recently, once the database exists; throws when it is unusable. */
	editLog(): EditLog | undefined {
		return this.existing()?.edits;
	}

	// Activity the parent and the user see: state, current tool, tokens.
	onAgentStart(): void {
		this.activity.update((me) => {
			me.status = "working";
			return undefined;
		}, true);
	}

	/** Delivers held interrupts first; a headless child then leaves because its parent closes its input. */
	onAgentSettled(): void {
		if (this.mail.settled()) return; // An interrupt stopped the run: its message starts the next turn.
		if (this.me && this.headless()) {
			this.activity.flush();
			this.leave();
			return;
		}
		// The activity line was cleared by src/ui/activity.ts, which owns it.
		this.activity.update((me) => {
			me.status = "idle";
			return undefined;
		}, true);
	}

	/** A subagent (no person to talk to, whatever its mode): once its run is over it gets no further turn. */
	private headless(): boolean {
		return Boolean(this.env[AGENT_ID_ENV] && this.ctx && !interactive(this.ctx, envFlag(this.env, SUBAGENT_ENV)));
	}

	/** Octocode is about to call the model with `messages`: team mail among them is now delivered. */
	onContext(messages: ReadonlyArray<{ role?: string; customType?: string; details?: unknown }>): void {
		this.delivery.seen(this.database.current, messages);
	}

	/** A top-level tool call started (parallel calls each count; calls a tool makes itself do not). */
	onToolStart(): void {
		this.activity.update((me) => {
			me.toolCalls += 1;
			return undefined;
		});
	}

	/** What the agent does now (the line src/ui/activity.ts describes), or undefined between steps and when idle. */
	setActivity(line: string | undefined): void {
		this.activity.update((me) => {
			if (line) me.activity = storedText(line, LINE_MAX);
			else delete me.activity;
			return undefined;
		});
	}

	/** One reply's usage; `model` wrote it (it changes when the user switches models); `unpriced`: that model has no pricing. */
	onUsage(usage: unknown, model: string | undefined, unpriced: boolean): void {
		this.activity.onUsage(usage, model, unpriced);
	}
}
