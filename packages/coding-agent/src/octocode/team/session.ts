import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { envFlag, ownNonce, SUBAGENT_ENV } from "../../../../common/src/env.ts";
import { interactive } from "../shared/interactive.ts";
import { storedText } from "../../../../common/src/sanitize.ts";
import type { Ask } from "./asks.ts";
import { checkInConfig } from "./check-in.ts";
import { Delivery } from "./delivery.ts";
import type { EditLog } from "./edits.ts";
import { HeldLeases } from "./held.ts";
import { agentName, LINE_MAX, modelRoute } from "./identity.ts";
import { Mail } from "./mail.ts";
import { RunAudit } from "./run-audit.ts";
import type { Lease, OpenQuestion, SendOptions } from "./model.ts";
import { Relays } from "./relay.ts";
import { Activity, HEARTBEAT_MS } from "./session/activity.ts";
import { ChildLeases } from "./session/child-leases.ts";
import { TeamDatabase } from "./session/database.ts";
import { type EndReason, settleReason } from "./session/end-reason.ts";
import { PeerHolder } from "./session/peer-holder.ts";
import { claimName, joinAtStart } from "./session/membership.ts";
import { SessionTeamName } from "./session/rejoin.ts";
import { endWithParent, watchParentProcess } from "./session/parent.ts";
import { lockPaths, type ReservationHost, reservationText, unlockPaths } from "./session/reservations.ts";
import * as refs from "./session/references.ts";
import { type MessageHook, type Resumer, type SendResult, sendMessage } from "./session/send.ts";
import { Vouches } from "./session/vouches.ts";
import { WaitingApprovals } from "./session/approvals.ts";
import { TeamTicker, type TeamView } from "./ticker.ts";
import { AGENT_ID_ENV, PARENT_ID_ENV } from "./store/env.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

/** This process's place in the team: joins, reports what it is doing, holds reservations and delivers messages sent to it. */
export class Team {
	private me: Member | undefined;
	private ctx: ExtensionContext | undefined;
	/** The team database, opened on first use (`session/database.ts`). */
	private readonly database = new TeamDatabase({ ctx: () => this.ctx, env: () => this.env }, () => this.ticker.sync());
	/** Every agent's join, state change and end (`lifecycle-bus.ts`): subscribe with `team.lifecycle.on`. */
	readonly lifecycle = this.database.lifecycle;
	/** What this agent records about the runs it starts, and where anyone finds an agent again (`run-audit.ts`). */
	readonly audit = new RunAudit(this.database);
	/** The one ticker: delivery and heartbeats while joined, a cached view for watchers (the panel). */
	private readonly ticker = new TeamTicker({
		joined: () => this.me !== undefined,
		beat: () => this.deliverMail(),
		dbFile: () => this.database.watchedFile(),
		read: () => this.database.read(),
		resumed: (since, now) => this.database.resumed(since, now),
		following: () => this.lifecycle.following,
		changed: () => this.lifecycle.poll(),
		maxAgeMs: HEARTBEAT_MS,
	});
	private readonly held = new HeldLeases();
	/** What this agent reserves for the children it starts (`paths` on a task). */
	readonly childLeases = new ChildLeases(() => this.reservationHost());
	/** The agents-communication package's path leases (read-only), opened on the first guarded write. */
	private readonly peers = new PeerHolder({
		self: () => this.ctx?.sessionManager.getSessionId(),
		warn: (text) => this.mail.notice(text),
	});
	private readonly mail: Mail;
	private readonly delivery: Delivery;
	/** This agent's status, tool counts and usage, written with the heartbeat (`session/activity.ts`). */
	private readonly activity: Activity;
	/** Stops the check that the parent still runs (a subagent only; on from the session start, joined or not). */
	private stopParentWatch: (() => void) | undefined;
	/** Subagents this session started that have finished: id → where their report went, for a later message to them. */
	private readonly finished = new Map<string, string>();
	/** Resumes a finished subagent that still lingers; `running` holds the subagents that have yet to report, by id (set by the subagents domain). */
	setResumer(resume: Resumer, running?: ReadonlyMap<string, unknown>): void {
		this.resumer = resume;
		this.running = running;
	}
	private resumer: Resumer | undefined;
	private running: ReadonlyMap<string, unknown> | undefined;
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
		this.database.forwardTo(api.events);
		this.name = new SessionTeamName(api, env);
		this.mail = new Mail(api, () => ownNonce(this.env));
		this.activity = new Activity({
			me: () => this.me,
			db: () => this.database.current,
			held: this.held,
			mail: this.mail,
			route: () => modelRoute(this.ctx?.model, api.getThinkingLevel()),
			renewChildren: (db, now) => this.childLeases.renew(db, now),
		});
		this.delivery = new Delivery(
			{
				id: () => this.me?.id,
				parentId: () => this.parentId,
				ctx: () => this.ctx,
				headless: () => this.headless(),
				heartbeat: (db) => this.activity.heartbeat(db),
				relays: (db) => this.relays.take(db),
				reporting: (id) => this.running?.has(id) === true,
				checkIn: () => checkInConfig(api.getSettings().subagents, this.env, api),
			},
			this.mail,
		);
	}
	private readonly vouches = new Vouches();
	readonly approvals = new WaitingApprovals();
	/** Registers the secret given to subagent `id` (its `PERMISSION_NONCE_FILE_ENV` file), so the user's messages to it are signed; returns what ends that. */
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

	/** Bind to the session and join the team: a subagent under the id its parent chose, a main session under the name a resumed session recorded or a new one. */
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
		this.name.start(resumeAs);
		joinAtStart(this.env, () => this.join());
	}

	/**
	 * A crashed parent's child spends tokens for nobody: once the parent is gone, Octocode's SIGTERM path disposes the session
	 * and exits (ARCHITECTURE: Liveness). Its own unref'd timer, so a child that could not join the team stops too.
	 */
	private watchParent(): void {
		this.stopParentWatch ??= watchParentProcess(this.env, () => {
			this.stopParentWatch?.();
			this.stopParentWatch = undefined;
			endWithParent((reason) => this.leave(reason));
		});
	}

	/** Set when the team database is foreign or too new; nothing team-related works until it is fixed. */
	get problem(): string | undefined {
		return this.database.problem;
	}

	/** A name held by no member of the shared database, finished subagent of this session or caller in `inUse` (a subagent not yet in it, or a name another process took first). */
	newName(inUse: Iterable<string> = []): string {
		let live: string[] = [];
		try {
			live = this.database.existing()?.names() ?? [];
		} catch {
			// An unusable database holds no names this process can read; avoid the rest.
		}
		return agentName([...live, ...this.finished.keys(), ...inUse, ...(this.me ? [this.me.id] : [])]);
	}

	/** Join (or refresh) as this process. Idempotent; `goal` replaces the one-line goal (validated by the caller with `checkGoal`, `identity.ts`). */
	join(goal?: string): Member {
		const db = this.database.store(); // throws before the session starts
		const ctx = this.ctx!;
		if (!this.me) {
			this.me = claimName(this.env, db, ctx, goal, (lost) => this.newName(lost), this.name);
			db.edits.adoptUnjoined(this.me.id);
			this.activity.joined(this.me);
			this.mail.followPeers(this.database.peers(() => this.me?.id));
			this.ticker.sync();
		} else if (goal !== undefined) {
			this.me.goal = storedText(goal, LINE_MAX);
		}
		this.activity.flush(db);
		return this.me;
	}

	/** Leave the team and release everything held; the database stays open for the next join. State clears first: a refused removal still throws, but leaves nothing stale (the row ages out). */
	leave(reason?: EndReason): void {
		const me = this.me;
		this.me = undefined;
		this.ticker.sync();
		this.held.clear();
		const db = this.database.current;
		this.delivery.reset(db, me?.id);
		this.mail.reset();
		// Only a row that still names this process: a name another process holds now is not ours to remove.
		if (me && db) db.remove(me.id, Date.now(), me, reason);
	}

	/** Leave and let go of the database (session end; the process connection stays open for the next session). */
	stop(): void {
		try {
			this.childLeases.stop();
			this.leave();
		} finally {
			this.stopParentWatch?.();
			this.stopParentWatch = undefined;
			this.database.release();
			this.peers.close();
			this.ticker.reset();
			this.relays.reset();
			this.finished.clear();
			this.vouches.clear();
			this.approvals.clear();
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

	/** Live agents (none when the database cannot be read; `snapshot` says why). */
	members(): Member[] {
		return this.snapshot().members;
	}

	stalled = (): Member[] => this.database.stalled(); // running, but silent for over a minute: shown by `coordinate list`
	/** Live agents and the latest messages between them, from one read. */
	snapshot(): TeamView {
		return this.approvals.overlay(this.database.snapshot());
	}

	/**
	 * Subagent `id` began or stopped waiting for the user's answer to a dialog. Its own process owns its row and cannot see
	 * the dialog, so the parent, who shows it, overlays the line on what it lists (`session/approvals.ts`).
	 */
	awaitingApproval(id: string, waiting: boolean): void {
		this.approvals.set(id, waiting);
	}

	/** The questions `child` sent its `parent` since `since`, with their answers; none when the database cannot be read (a measurement never fails its run). */
	asks(child: string, parent: string, since: number): Ask[] {
		return this.database.asks(child, parent, since);
	}

	/** The questions members read and have not answered, with ids and senders (`coordinate list`, `/agents`). */
	openQuestions(): OpenQuestion[] {
		return this.database.openQuestions();
	}

	/** Closes this session's open questions to `child`: its report answered them (`references.ts`). */
	closeQuestionsTo = (child: string): void => refs.closeQuestionsTo(this.sendHost(), child);

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
			store: () => this.database.store(),
			parentId: () => this.parentId,
			finished: this.finished,
			reporting: (id) => this.running?.has(id) === true,
			starting: () => [...(this.running?.keys() ?? [])],
			resumer: () => this.resumer,
			messageHook: () => this.messageHook,
			signed: (id, recipient, text) => this.vouches.signed(id, recipient, text),
			signedByParent: (message) => this.vouches.signedByParent(message),
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
			chosenId: () => this.env[AGENT_ID_ENV],
			store: () => this.database.store(),
			existing: () => this.database.existing(),
			held: this.held,
			// Whether this agent takes part in the team: it joined, or still tracks reservations.
			collaborating: () => this.me !== undefined || this.held.any,
			peerLeases: () => this.peers.get(),
		};
	}

	/** Why the file may not be changed (another agent's reservation, in this team or in agents-communication; our lapsed one; or an unreadable team database), or undefined; with no file, any reservation another agent holds. */
	reservation(absolute: string | undefined, display: string): string | undefined {
		return reservationText(this.reservationHost(), absolute, display);
	}

	/** Who changed which file recently, once the database exists; throws when it is unusable. */
	editLog(): EditLog | undefined {
		return this.database.existing()?.edits;
	}

	// Activity the parent and the user see: state, current tool, tokens.
	onAgentStart(): void {
		this.activity.started();
	}

	/** Delivers held interrupts first; a headless child then leaves, saying how its run ended, because its parent closes its input. */
	onAgentSettled(status?: string): void {
		if (this.mail.settled()) return; // An interrupt stopped the run: its message starts the next turn.
		if (this.me && this.headless()) {
			this.activity.flush();
			this.leave(settleReason(status));
			return;
		}
		// The activity line was cleared by src/ui/activity.ts, which owns it.
		this.activity.idle();
	}

	/** A subagent (no person to talk to, whatever its mode): once its run is over it gets no further turn. */
	private headless(): boolean {
		return Boolean(this.env[AGENT_ID_ENV] && this.ctx && !interactive(this.ctx, envFlag(this.env, SUBAGENT_ENV)));
	}

	/** Hands waiting mail to Octocode: every second from the ticker, and at the end of a turn that ran tools (`tools.ts`, `stepEnded`). */
	deliverMail(stepEnded = false): void {
		this.delivery.deliver(this.database.current, stepEnded);
	}

	/** Octocode is about to call the model with `messages`: team mail among them is now delivered. */
	onContext(messages: ReadonlyArray<{ role?: string; customType?: string; details?: unknown }>): void {
		this.delivery.seen(this.database.current, messages);
	}

	onToolStart(): void {
		this.activity.toolStarted();
	}
	setActivity(line: string | undefined): void {
		this.activity.setLine(line);
	}

	readonly setModel = (route: string | undefined): void => this.activity.setModel(route);

	/** One reply's usage; `model` wrote it (it changes when the user switches models); `unpriced`: that model has no pricing. */
	onUsage(usage: unknown, model: string | undefined, unpriced: boolean): void {
		this.activity.onUsage(usage, model, unpriced);
	}
}
