import { randomBytes } from "node:crypto";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { ExtensionContext } from "../../core/features/index.ts";
import { USER_SENDER } from "../shared/messages.ts";
import { newMember } from "./identity.ts";
import { parentProofValid, userProofValid } from "./proof.ts";
import { messageText, resolveTarget, sessionTree } from "./routing.ts";
import { spillIntact } from "./spill.ts";
import { AGENT_ROLE_ENV, PARENT_ID_ENV } from "./store/env.ts";
import { sendMessage, type SendHost } from "./session/send.ts";
import { HEARTBEAT_MS } from "./session/activity.ts";
import type { TeamStore } from "./store.ts";
import { Place } from "./store/place.ts";

export interface RunnerMemberInput {
	id: string;
	runner: string;
	goal?: string;
	model?: string;
	sessionId?: string;
	cwd: string;
	signal?: AbortSignal;
}

/** A turn's member borrows its parent's process lifetime, never its sender authority. */
export class RunnerMember {
	readonly member: Member;
	private readonly db: TeamStore;
	private readonly parent: Member;
	private readonly context: ExtensionContext;
	private readonly heartbeat: NodeJS.Timeout;
	private readonly signal: AbortSignal | undefined;
	private readonly secret = randomBytes(32).toString("base64url");
	private readonly fetched = new Set<number>();
	private readonly unvouch: () => void;
	private closed = false;
	private readonly sender: SendHost;
	private readonly host: SendHost;

	constructor(host: SendHost, input: RunnerMemberInput, vouch: (id: string, secret: string) => () => void) {
		this.host = host;
		const parent = host.me(),
			context = host.ctx();
		input.signal?.throwIfAborted();
		if (!parent || !context) throw new Error("Join the team before starting a runner mailbox.");
		this.parent = parent;
		this.context = context;
		this.signal = input.signal;
		this.db = host.store();
		const place = new Place(input.cwd).read();
		this.member = {
			...newMember(
				{ [AGENT_ROLE_ENV]: `runner ${input.runner}`, [PARENT_ID_ENV]: parent.id },
				context,
				input.id,
				input.goal,
				Date.now(),
			),
			status: "working",
			cwd: input.cwd,
			branch: place.branch,
			model: input.model ? `${input.runner}/${input.model}` : input.runner,
			sessionId: input.sessionId,
			mailbox: "pull",
		};
		if (!this.db.join(this.member, parent)) throw new Error(`The team name ${input.id} is already held.`);
		this.unvouch = vouch(input.id, this.secret);
		this.sender = {
			...host,
			me: () => (this.current() ? this.member : undefined),
			ctx: () => (this.current() ? this.context : undefined),
			parentId: () => this.parent.id,
			finished: new Map(),
			reporting: () => false,
			starting: () => [],
			resumer: () => undefined,
			signed: () => undefined,
			signedByParent: () => undefined,
		};
		this.heartbeat = setInterval(() => {
			try {
				if (!this.current()) return;
				this.member.updatedAt = Date.now();
				this.db.save(this.member);
			} catch {
				/* A busy database is retried at the next heartbeat. */
			}
		}, HEARTBEAT_MS);
		this.heartbeat.unref();
	}

	private current(): boolean {
		if (this.closed || this.host.me() !== this.parent || this.host.ctx() !== this.context || this.host.db() !== this.db)
			return false;
		return this.db.owns(this.member);
	}

	private ready(signal?: AbortSignal): void {
		this.signal?.throwIfAborted();
		signal?.throwIfAborted();
		if (!this.current()) throw new Error("This runner mailbox has closed or its parent session changed.");
	}

	list(signal?: AbortSignal) {
		this.ready(signal);
		const members = this.db.list();
		const tree = sessionTree(members, this.member.id);
		return members
			.filter((member) => tree.has(member.id))
			.map(({ id, role, goal, status, parentId }) => ({ id, role, goal, status, parentId }));
	}

	inbox(ack: number[], signal?: AbortSignal) {
		this.ready(signal);
		if (ack.some((id) => !this.fetched.has(id)))
			throw new Error("Acknowledge only message IDs previously fetched by this mailbox.");
		this.db.ack(this.member.id, ack);
		for (const id of ack) this.fetched.delete(id);
		const batch = this.db.pending(this.member.id);
		for (const message of batch) this.fetched.add(message.id);
		return batch.map((message) => ({
			id: message.id,
			from: message.from,
			replyRequired: message.replyRequired,
			text: messageText(message, {
				parentId: this.parent.id,
				fromUser: message.from === USER_SENDER && userProofValid(this.secret, message) && spillIntact(message.text),
				parentUnverified: !parentProofValid(this.secret, message) || !spillIntact(message.text),
			}),
		}));
	}

	async send(
		to: string | undefined,
		text: string,
		options: { replyTo?: number; replyRequired?: boolean },
		signal?: AbortSignal,
	) {
		this.ready(signal);
		const target = to ?? (options.replyTo === undefined ? undefined : this.db.replyTarget(options.replyTo)?.from);
		if (target === undefined) return { error: "Name a teammate or a received message to answer." };
		const route = resolveTarget(this.db.list(), this.member.id, target, this.parent.id, this.member.id);
		if (typeof route === "string") return { error: route };
		const joined = signal && this.signal ? AbortSignal.any([signal, this.signal]) : (signal ?? this.signal);
		return sendMessage(this.sender, to, text, { ...options, signal: joined });
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.heartbeat);
		this.fetched.clear();
		this.unvouch();
		// The store removes only the row still naming this process identity.
		this.db.remove(this.member.id, Date.now(), this.member);
	}
}
