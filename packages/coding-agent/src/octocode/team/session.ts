import type { ExtensionContext } from "../../core/features/index.ts";
import { storedText } from "../../../../common/src/sanitize.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import type { Ask } from "./asks.ts";
import type { EditLog } from "./edits.ts";
import { agentName, LINE_MAX } from "./identity.ts";
import type { Lease, OpenQuestion, SendOptions } from "./model.ts";
import { type EndReason, settleReason } from "./session/end-reason.ts";
import { claimName, joinAtStart } from "./session/membership.ts";
import { endWithParent, namedParent, watchParentProcess } from "./session/parent.ts";
import { isReserved, lockPaths, reservationText, unlockPaths } from "./session/reservations.ts";
import * as refs from "./session/references.ts";
import { type SendResult, sendMessage } from "./session/send.ts";
import type { TeamView } from "./ticker.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { TeamState } from "./session/state.ts";
import { PARENT_HOLDS_LEASES_ENV } from "./store/env.ts";
import { patiently } from "./store/patient.ts";
import { openRunnerBridge } from "./runner-bridge.ts";
import type { RunnerMemberInput } from "./runner-member.ts";

/** This process's place in the team: joins, reports what it is doing, holds reservations and delivers messages sent to it. */
export class Team extends TeamState {
	private readonly runnerBridgeIds = new Set<string>();
	/** Restricts an external turn to its own team identity and cooperative mailbox. */
	async runnerBridge(input: RunnerMemberInput) {
		if (this.runnerBridgeIds.has(input.id)) throw new Error(`The runner mailbox ${input.id} is already open.`);
		this.runnerBridgeIds.add(input.id);
		try {
			const bridge = await openRunnerBridge(this.sendHost(), input, (id, secret) => this.vouch(id, secret));
			let closing: Promise<void> | undefined;
			return {
				...bridge,
				close: () =>
					(closing ??= (async () => {
						try {
							await bridge.close();
						} finally {
							this.runnerBridgeIds.delete(input.id);
						}
					})()),
			};
		} catch (error) {
			this.runnerBridgeIds.delete(input.id);
			throw error;
		}
	}
	/** Aborted while an interrupt waits for this agent's run to stop, or a question from its coordinator for its model (`agent_before_settle` waits end early on it). */
	get interrupted(): AbortSignal {
		return AbortSignal.any([this.mail.interrupted, this.mail.asked]);
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
	leave(reason?: EndReason, settled = false): void {
		const me = this.me;
		this.me = undefined;
		this.ticker.sync();
		this.held.clear();
		const db = this.database.current;
		this.delivery.reset(db, me?.id);
		this.mail.reset();
		// Only a row that still names this process: a name another process holds now is not ours to remove.
		if (me && db && !settled) db.remove(me.id, Date.now(), me, reason);
	}

	/** Leave and let go of the database (session end; the process connection stays open for the next session). */
	stop(): void {
		try {
			this.leave();
		} finally {
			this.stopParentWatch?.();
			this.stopParentWatch = undefined;
			this.database.release();
			this.peers.close();
			this.ticker.reset();
			this.relays.reset();
			this.finished.clear();
			this.runnerTasks.clear();
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
	/**
	 * Runs a team write the agent asked for (`join`, `leave`, `lock`, `unlock`) without waiting inside SQLite: while
	 * another process holds the database it is tried again after a pause (`store/patient.ts`). Without a usable store
	 * `work` runs as it is, so its own error is the one reported.
	 */
	async patiently<T>(work: () => T, signal?: AbortSignal): Promise<T> {
		const store = (() => {
			try {
				return this.database.store();
			} catch {
				return undefined;
			}
		})();
		return store ? patiently(store, work, signal) : work();
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

	/** Whether any agent in the team or agents-communication, this one included, holds a live reservation covering the file. */
	reserved(absolute: string): boolean {
		return isReserved(this.reservationHost(), absolute);
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
			const reason = settleReason(status);
			// Leases the parent reserved stay with the parent until its run ends (`ChildLeases.release`); the row is settled, not retired.
			const parent = namedParent(this.env);
			const db = this.database.current;
			const settled =
				this.env[PARENT_HOLDS_LEASES_ENV] === "1" && !!parent && !!db && db.settle(this.me.id, this.me, parent, reason);
			this.leave(reason, settled);
			return;
		}
		// The activity line was cleared by src/ui/activity.ts, which owns it.
		this.activity.idle();
	}

	/** Hands waiting mail to Octocode: every second from the ticker, and at the end of a turn that ran tools (`tools.ts`, `stepEnded`). */
	deliverMail(stepEnded = false): void {
		this.delivery.deliver(this.database.current, stepEnded);
		this.watchSilence();
	}

	/** Tells this agent about a working child with no progress for `subagents.silenceMinutes`; reads the database only when one is due. */
	private watchSilence(now = Date.now()): void {
		const children = [...(this.running?.keys() ?? [])].map((id) => ({ id, lastOutputAt: this.approvals.lastOutput(id) }));
		const thresholdMs = this.silenceMs();
		const due = this.silence.due(children, thresholdMs, now);
		if (due.length === 0) return;
		const members = new Map(this.database.read().members.map((member) => [member.id, member]));
		for (const id of due) {
			const member = members.get(id);
			if (!member || member.status !== "working" || this.approvals.waitsOnUser(id)) {
				this.silence.excused(id, now);
				continue;
			}
			const minutes = Math.round((now - this.approvals.lastOutput(id)!) / 60_000);
			const text = renderInstruction("notices/subagents/child-silent.md", { id, minutes, activity: member.activity });
			const wake = this.wakePace.allows();
			if (!this.mail.alert(text, wake)) continue;
			if (wake) this.wakePace.record();
			this.silence.told(id);
		}
	}

	/** Octocode is about to call the model with `messages`: team mail among them is now delivered. */
	onContext(messages: ReadonlyArray<{ role?: string; customType?: string; details?: unknown }>): void {
		this.delivery.seen(this.database.current, messages);
	}

	readonly onToolStart = (): void => this.activity.toolStarted();
	readonly setActivity = (line: string | undefined): void => this.activity.setLine(line);

	readonly setModel = (route: string | undefined): void => this.activity.setModel(route);

	/** One reply's usage; `model` wrote it (it changes when the user switches models); `unpriced`: that model has no pricing. */
	onUsage(usage: unknown, model: string | undefined, unpriced: boolean): void {
		this.activity.onUsage(usage, model, unpriced);
	}
}
