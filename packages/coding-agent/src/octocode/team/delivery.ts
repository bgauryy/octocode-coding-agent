import { renderInstruction } from "../../core/prompt-template.ts";
import type { ExtensionContext } from "../../core/features/index.ts";
import { notify } from "../shared/commands.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { CheckIn, type CheckInConfig } from "./check-in.ts";
import { Inbox } from "./inbox.ts";
import { type Mail, mailIds } from "./mail.ts";
import type { Message } from "./model.ts";
import { outside } from "./routing.ts";
import type { TeamStore } from "./store.ts";
import { WakePace } from "./wake-pace.ts";

/** Consecutive failed ticks (about 30s) before the agent hears that the team database is unavailable. */
const FAILED_TICKS_NOTICE = 30;
/** An idle agent handed a waking message that the model has not been called with after this long was not started by Octocode (no model, or no sign-in). */
const WAKE_STUCK_MS = 10_000;

/** What delivery needs from the agent's membership (`Team`), read when used so it always sees the current session. */
interface DeliveryHost {
	/** This agent's id, undefined while it has not joined. */
	id(): string | undefined;
	parentId(): string | undefined;
	ctx(): ExtensionContext | undefined;
	/** A subagent with no person to talk to (`Team.headless`). */
	headless(): boolean;
	/** Writes the heartbeat if one is due (a status change, or the interval passed); whether it did. */
	heartbeat(db: TeamStore): boolean;
	/** Settles the relay requests children left for this agent's process (`Relays.take`). */
	relays(db: TeamStore): void;
	/** Whether a subagent of this session has not filed its report yet: its report may still answer what it was asked (`Mail.reportDeadLetters`). */
	reporting(id: string): boolean;
	/** The check-in's setting, read when a step ends. */
	checkIn(): CheckInConfig;
}

/**
 * The receive side of the team, run on every tick: hands waiting mail to Octocode through the `Inbox`, records it once the
 * model is called with it, reports a wake Octocode never started, and counts failed ticks. It owns the inbox and the wake and
 * failure state; the membership, the heartbeat and the sending stay with `Team`.
 */
export class Delivery {
	private readonly inbox = new Inbox();
	private readonly checkIn: CheckIn;
	private failedTicks = 0;
	/** When an idle agent was handed a waking message that has not reached the model yet; undefined when none is outstanding. */
	private wakeHandedAt: number | undefined;
	/** The user was told about the current stuck wake. */
	private wakeReported = false;

	private readonly host: DeliveryHost;
	private readonly mail: Mail;
	/** How often peers may start this agent's turns while it is idle (`wake-pace.ts`). */
	private readonly pace: WakePace;
	constructor(host: DeliveryHost, mail: Mail, pace = new WakePace()) {
		this.host = host;
		this.mail = mail;
		this.pace = pace;
		this.checkIn = new CheckIn(mail);
	}

	/**
	 * Two-phase delivery: hand what is waiting to Octocode (the inbox records it once the model sees it), then the heartbeat.
	 * `stepEnded`: called at the end of a step that ran tools, with the next request about to be made.
	 */
	deliver(db: TeamStore | undefined, stepEnded = false): void {
		const me = this.host.id();
		if (!me || !db) return;
		this.checkIn.begin();
		try {
			db.quick(() => this.deliverNow(db));
			this.failedTicks = 0;
		} catch (error) {
			// A locked or closed database is retried on the next tick; say so once if it lasts long enough for leases to lapse.
			if (++this.failedTicks === FAILED_TICKS_NOTICE)
				this.mail.notice(renderInstruction("notices/mail/team-db-unavailable.md", { error: errorMessage(error) }));
		}
		if (stepEnded) this.sendCheckIn(db, me);
	}

	/** Fails open: a busy database or an unreadable setting costs this ping, and the next step tries again. */
	private sendCheckIn(db: TeamStore, me: string): void {
		try {
			db.quick(() => this.checkIn.due(db, me, this.host.parentId(), this.host.checkIn()));
		} catch {
			// Nothing depends on a ping.
		}
	}

	/** Octocode is about to call the model with `messages`: the team mail among them is now delivered. */
	seen(
		db: TeamStore | undefined,
		messages: ReadonlyArray<{ role?: string; customType?: string; details?: unknown }>,
	): void {
		const me = this.inbox.awaitingContext ? this.host.id() : undefined;
		const ids = me && db ? messages.flatMap((message) => mailIds(message, me)) : [];
		if (!me || !db || ids.length === 0) return;
		// The model has these messages now, even if database acknowledgement must wait for the next tick.
		for (const id of ids) this.mail.forgetForUser(id, me);
		try {
			db.quick(() => this.inbox.seen(db, me, ids));
		} catch {
			// Busy database: the inbox keeps the ids and records them on the next tick.
		}
	}

	/** The agent left: records what the model saw if it can, and forgets the rest (`id` is the id it left under). */
	reset(db: TeamStore | undefined, id: string | undefined): void {
		this.inbox.reset(db, id);
		this.checkIn.reset();
		this.wakeHandedAt = undefined;
		this.wakeReported = false;
		this.pace.reset();
	}

	private deliverNow(db: TeamStore): void {
		const id = this.host.id();
		if (!id) return;
		const ctx = this.host.ctx();
		const headlessIdle = this.host.headless() && ctx?.isIdle();
		// A settlement send can fail while Octocode changes state. An interactive session stays alive to retry held mail.
		if (!this.host.headless() && ctx?.isIdle()) this.mail.settled();
		// An idle subagent without a UI has had its last turn: mail and relay requests wait, and become dead letters when it leaves.
		if (!headlessIdle) {
			this.host.relays(db);
			this.inbox.deliver(
				db,
				id,
				(batch, onRejected) => this.handOver(db, id, batch, onRejected),
				ctx?.isIdle() ?? false,
			);
		}
		this.checkWake();
		if (this.host.heartbeat(db)) this.mail.reportDeadLetters(db, id, (recipient) => this.host.reporting(recipient));
		this.mail.pruneForUser(db);
	}

	/**
	 * Hands a batch to Octocode; notes when it should wake an idle agent, to tell whether Octocode started that turn (`checkWake`).
	 * An idle agent whose batch is woken only by peers' messages waits while `WakePace` does not allow another peer-started turn:
	 * refusing keeps the mail in the inbox, which offers it again on the next tick together with whatever arrived meanwhile.
	 */
	private handOver(db: TeamStore, me: string, batch: Message[], onRejected: () => void): boolean {
		const ctx = this.host.ctx();
		const idle = ctx?.isIdle() === true;
		const waking = batch.filter((message) => message.wake);
		const paced = idle ? waking.filter((message) => this.paced(db, me, message)) : [];
		if (paced.length > 0 && paced.length === waking.length && !this.pace.allows()) return false;
		// Octocode can refuse the handoff after accepting the call (no model, a turn it cannot start): that turn never ran.
		let counted: number | undefined;
		const rejected = () => {
			if (counted !== undefined) this.pace.undo(counted);
			onRejected();
		};
		const handed = this.mail.deliver(batch, this.host.parentId(), ctx, rejected);
		if (handed && idle && waking.length > 0) {
			this.wakeHandedAt ??= Date.now();
			if (paced.length > 0) counted = this.pace.record();
		}
		return handed;
	}

	/**
	 * Whether waking this agent is a peer's choice, and so paced: not the user's or an API client's message, not an interrupt,
	 * and not the answer to a question this agent asked and still waits on.
	 */
	private paced(db: TeamStore, me: string, message: Message): boolean {
		if (!message.wake || message.interrupt || outside(message.from)) return false;
		if (message.replyTo === undefined) return true;
		const asked = db.replyTarget(message.replyTo);
		return !(asked?.from === me && asked.replyRequired);
	}

	/**
	 * Octocode swallows a refused turn start (no model selected, no sign-in): the message then stays handed but unseen until the
	 * agent leaves, when it becomes a dead letter. An idle agent that still has not reached the model with a waking message
	 * after `WAKE_STUCK_MS` is reported to its user once, so the cause (`/model`, `/login`) is not a silent wait.
	 */
	private checkWake(): void {
		if (this.wakeHandedAt === undefined) return;
		const ctx = this.host.ctx();
		if (!this.inbox.awaitingContext || !ctx || !ctx.isIdle()) {
			// The model saw it, or a turn is running: nothing is stuck.
			this.wakeHandedAt = undefined;
			this.wakeReported = false;
			return;
		}
		if (this.wakeReported || Date.now() - this.wakeHandedAt < WAKE_STUCK_MS) return;
		this.wakeReported = true;
		if (ctx.hasUI)
			notify(
				ctx.ui,
				"A team message should have started a turn, but Octocode did not run one (select a model with /model and sign in with /login). The message stays queued; its sender is told it went unread if this session ends first.",
				"warning",
			);
	}
}
