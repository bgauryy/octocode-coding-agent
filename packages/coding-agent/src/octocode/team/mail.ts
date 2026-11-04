import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { PeerNotices, type PeerNoticeHost } from "./peer-left.ts";
import { INTERNAL_MESSAGE_TYPE, USER_SENDER } from "../shared/messages.ts";
import type { DeadLetter, MailDetails, Message } from "./model.ts";
import { parentProofValid, userProofValid } from "./proof.ts";
import { deadLetterText, messageText } from "./routing.ts";
import { spillIntact } from "./spill.ts";
import type { TeamStore } from "./store.ts";

/** Puts team mail and team notices in front of this agent's model, one Octocode custom message each (`MailDetails`). */
export class Mail {
	/** Mail held by an interrupt until the stopped run settles. */
	private held: { batch: Message[]; parentId: string | undefined; onRejected?: () => void } | undefined;
	/** Aborted while mail is held: a wait at the end of the run (background work) stops for it. */
	private holding = new AbortController();
	/** Notices already handed to Octocode whose database acknowledgement still needs retrying. */
	private notified: DeadLetter[] = [];
	/** A dead-letter notice awaiting the host's asynchronous acceptance; do not hand it over twice. */
	private noticePending = false;
	private generation = 0;
	/** Exact messages this process created for the user; shared database ids and sender columns alone are forgeable. */
	private readonly forUser = new Map<number, { text: string; recipients: Set<string> }>();
	private lastProvenancePrune = 0;

	/** `secret`: what the parent gave this process (a subagent), which checks a user message the parent signed (`userProof`). */
	private readonly api: Pick<ExtensionAPI, "sendMessage">;
	private readonly secret: () => string | undefined;
	constructor(api: Pick<ExtensionAPI, "sendMessage">, secret: () => string | undefined = () => undefined) {
		this.api = api;
		this.secret = secret;
	}

	/**
	 * Whether the message is verifiably the user's: created here for the user, or signed with this process's secret by the
	 * parent (the signature covers the head and the path of a long message), and in both cases the file it points at, if any,
	 * still holds what was saved (the file is read outside the signature).
	 */
	private verified(message: Message): boolean {
		const created = this.forUser.get(message.id);
		return (
			message.from === USER_SENDER &&
			((created?.text === message.text && created.recipients.has(message.to)) ||
				userProofValid(this.secret(), message)) &&
			spillIntact(message.text)
		);
	}

	/** Whether the parent signed `message` for this process, and the file it points at, if any, still holds what was saved. */
	private parentSigned(message: Message): boolean {
		return parentProofValid(this.secret(), message) && spillIntact(message.text);
	}

	/** Binds in-process user provenance to the exact text and recipients, as the child proof does. */
	createdForUser(id: number, text: string, recipients: readonly string[]): void {
		this.forUser.set(id, { text, recipients: new Set(recipients) });
	}

	/** A recipient reached the model or left without reading; retain proof only for recipients still awaiting mail. */
	forgetForUser(id: number, recipient: string): void {
		const created = this.forUser.get(id);
		if (!created) return;
		created.recipients.delete(recipient);
		if (created.recipients.size === 0) this.forUser.delete(id);
	}

	/** Retire proofs for agents whose process can no longer receive their queued message. */
	pruneForUser(db: TeamStore, now = Date.now()): void {
		if (this.forUser.size === 0 || (now >= this.lastProvenancePrune && now - this.lastProvenancePrune < 30_000)) return;
		const live = db.reachable();
		for (const [id, created] of this.forUser)
			for (const recipient of created.recipients) if (!live.has(recipient)) this.forgetForUser(id, recipient);
		this.lastProvenancePrune = now;
	}

	/** A team notice for this agent, read at its next step; never starts a turn. False when the session cannot take it. */
	notice(text: string, onRejected?: () => void, onAccepted?: () => void): boolean {
		return this.inject(
			text,
			{ messages: [{ from: "team", text, at: Date.now() }] },
			{ triggerTurn: false, deliverAs: "steer" },
			onRejected,
			onAccepted,
		);
	}

	private peers: PeerNotices | undefined;

	/** Starts telling this agent when a peer it corresponded with ends (`peer-left.ts`); `reset` stops it. */
	followPeers(host: Omit<PeerNoticeHost, "mail">): void {
		this.peers ??= new PeerNotices({ ...host, mail: this });
		this.peers.watch();
	}

	/** One line that a peer ended: an FYI read at the next step, or, with `wake`, one that starts a turn of an idle agent (a question of this agent's is left open). */
	peerLeft(text: string, wake: boolean): boolean {
		return this.inject(
			text,
			{ messages: [{ from: "team", text, at: Date.now() }] },
			{ triggerTurn: wake, deliverAs: "steer" },
		);
	}

	/**
	 * One Octocode message for the whole batch, so a busy agent reads all of it at its next step (steer); only a batch with a
	 * message that wants action wakes an idle one. False when the session cannot take it: the messages stay pending.
	 */
	deliver(
		batch: Message[],
		parentId: string | undefined,
		ctx?: Pick<ExtensionContext, "isIdle" | "abort">,
		onRejected?: () => void,
	): boolean {
		// A steer is read only after the running tool returns: an interrupt stops the run instead (Octocode cancels the tool),
		// and the batch starts the next turn once the run has settled (`settled`).
		// The interrupt is not tied to `verified`, on purpose: the agent that started this one is legitimately not "the user"
		// and may stop it. What limits who can interrupt is the sender (`interruptRefusal`, checked where a message is sent):
		// only the agent that started the recipient, or the user of its session (`/agents tell --interrupt`; an API client
		// and a peer cannot). A row written around that check (same-user write access to the shared database) can still stop a
		// run; it cannot make it read the text as the user's, because that needs the signature (`verified`).
		if (ctx && !ctx.isIdle() && batch.some((message) => message.interrupt)) {
			try {
				ctx.abort();
				const previous = this.held?.onRejected;
				this.held = {
					batch: [...(this.held?.batch ?? []), ...batch],
					parentId,
					onRejected: () => {
						previous?.();
						onRejected?.();
					},
				};
				this.holding.abort();
				return true;
			} catch {
				// The run cannot be stopped: deliver it as a waking message instead.
			}
		}
		return this.send(batch, parentId, false, onRejected);
	}

	/** Aborted while an interrupt holds mail for the stopped run. */
	get interrupted(): AbortSignal {
		return this.holding.signal;
	}

	private send(batch: Message[], parentId: string | undefined, stopped: boolean, onRejected?: () => void): boolean {
		const content = batch
			.map((message) =>
				messageText(message, {
					parentId,
					stopped,
					fromUser: this.verified(message),
					parentUnverified: !this.parentSigned(message),
				}),
			)
			.join("\n\n");
		return this.inject(
			content,
			{ messages: batch },
			{ triggerTurn: batch.some((message) => message.wake), deliverAs: "steer" },
			onRejected,
		);
	}

	/**
	 * The run settled: mail an interrupt held starts the next turn (Octocode runs a turn triggered while it settles before it
	 * reports idle, so a headless subagent continues instead of exiting). True when it did.
	 */
	settled(): boolean {
		const held = this.held;
		if (!held || !this.send(held.batch, held.parentId, true, held.onRejected)) return false;
		this.releaseInterrupt();
		return true;
	}

	/** Forgets held mail (the agent left): never started, it stays undelivered. */
	reset(): void {
		this.generation++;
		this.notified = [];
		this.noticePending = false;
		this.forUser.clear();
		this.lastProvenancePrune = 0;
		this.releaseInterrupt();
		this.peers?.stop();
	}

	private releaseInterrupt(): void {
		this.held = undefined;
		if (this.holding.signal.aborted) this.holding = new AbortController();
	}

	/**
	 * Tells this agent, once and without waking it, about messages it sent that their recipients left without reading or
	 * answering. A child leaves before its report is built, so a question it read waits while `reporting` says that report is
	 * still to come: the report closes it (`closeQuestionsTo`), and only a run that ends without one reports it unanswered.
	 */
	reportDeadLetters(db: TeamStore, id: string, reporting: (recipient: string) => boolean = () => false): void {
		this.recordNotices(db);
		if (this.noticePending) return;
		const letters = db.deadLetters(id).filter((letter) => !letter.read?.some(reporting));
		if (letters.length === 0) return;
		const generation = this.generation;
		this.noticePending = true;
		const current = () => generation === this.generation;
		if (
			!this.notice(
				letters.map(deadLetterText).join("\n\n"),
				() => {
					if (current()) this.noticePending = false;
				},
				() => {
					if (!current()) return;
					this.noticePending = false;
					this.notified = letters;
					this.recordNotices(db);
				},
			)
		)
			this.noticePending = false;
	}

	private recordNotices(db: TeamStore): void {
		if (this.notified.length === 0) return;
		db.markNotified(this.notified);
		this.notified = [];
	}

	private inject(
		content: string,
		details: MailDetails,
		options: { triggerTurn?: boolean; deliverAs: "steer" },
		onRejected?: () => void,
		onAccepted?: () => void,
	): boolean {
		let sending: void | Promise<void>;
		try {
			sending = this.api.sendMessage({ customType: INTERNAL_MESSAGE_TYPE, content, display: true, details }, options);
		} catch {
			return false; // The session ended or is not ready.
		}
		if (sending && typeof sending.then === "function")
			void Promise.resolve(sending).then(
				() => {
					try {
						onAccepted?.();
					} catch {
						// Database acknowledgement is retained and retried on the next heartbeat.
					}
				},
				() => onRejected?.(),
			);
		else onAccepted?.();
		return true;
	}
}

/** The ids of the messages to `me` that a Octocode message carries, when it is team mail (details are untrusted data). */
export function mailIds(message: { role?: string; customType?: string; details?: unknown }, me: string): number[] {
	if (message.role !== "custom" || message.customType !== INTERNAL_MESSAGE_TYPE) return [];
	const mail = (message.details as Partial<MailDetails> | undefined)?.messages;
	return Array.isArray(mail)
		? mail.flatMap((entry) => (typeof entry?.id === "number" && entry.to === me ? [entry.id] : []))
		: [];
}
