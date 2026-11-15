import type { ExtensionAPI, ExtensionContext } from "../../../core/features/index.ts";
import { envFlag, ownNonce, SUBAGENT_ENV } from "../../../../../common/src/env.ts";
import { interactive } from "../../shared/interactive.ts";
import { checkInConfig } from "../check-in.ts";
import { Delivery } from "../delivery.ts";
import { HeldLeases } from "../held.ts";
import { modelRoute } from "../identity.ts";
import { Mail } from "../mail.ts";
import { RunAudit } from "../run-audit.ts";
import { Relays } from "../relay.ts";
import { Activity, HEARTBEAT_MS } from "./activity.ts";
import { ChildLeases } from "./child-leases.ts";
import { TeamDatabase } from "./database.ts";
import { PeerHolder } from "./peer-holder.ts";
import { SessionTeamName } from "./rejoin.ts";
import type { ReservationHost } from "./reservations.ts";
import type { ReferenceHost } from "./references.ts";
import type { MessageHook, Resumer } from "./send.ts";
import { Vouches } from "./vouches.ts";
import { WaitingApprovals } from "./approvals.ts";
import { TeamTicker } from "../ticker.ts";
import { WakePace } from "../wake-pace.ts";
import { AGENT_ID_ENV, PARENT_ID_ENV } from "../store/env.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

const RECENT_FINISHED_LIMIT = 128;

/**
 * What a team member holds for its process (identity, database, ticker, mail, reservations, vouches) and the hosts the
 * send and reservation helpers read it through. `Team` (`../session.ts`) owns the public operations on top of it.
 */
export abstract class TeamState {
	protected me: Member | undefined;
	protected ctx: ExtensionContext | undefined;
	/** The team database, opened on first use (`session/database.ts`). */
	protected readonly database = new TeamDatabase({ ctx: () => this.ctx, env: () => this.env }, () =>
		this.ticker.sync(),
	);
	/** Every agent's join, state change and end (`lifecycle-bus.ts`): subscribe with `team.lifecycle.on`. */
	readonly lifecycle = this.database.lifecycle;
	/** What this agent records about the runs it starts, and where anyone finds an agent again (`run-audit.ts`). */
	readonly audit = new RunAudit(this.database);
	/** The one ticker: delivery and heartbeats while joined, a cached view for watchers (the panel). */
	protected readonly ticker = new TeamTicker({
		joined: () => this.me !== undefined,
		beat: () => this.deliverMail(),
		dbFile: () => this.database.watchedFile(),
		read: () => this.database.read(),
		resumed: (since, now) => this.database.resumed(since, now),
		following: () => this.lifecycle.following,
		changed: () => this.lifecycle.poll(),
		maxAgeMs: HEARTBEAT_MS,
	});
	protected readonly held = new HeldLeases();
	/** What this agent reserves for the children it starts (`paths` on a task). */
	readonly childLeases = new ChildLeases(() => this.reservationHost());
	/** The agents-communication package's path leases (read-only), opened on the first guarded write. */
	protected readonly peers = new PeerHolder({
		self: () => this.ctx?.sessionManager.getSessionId(),
		warn: (text) => this.mail.notice(text),
	});
	protected readonly mail: Mail;
	/** How often peers and the coordination graph (`subagents/graph-wake.ts`) may start this agent's turns while it is idle: one budget. */
	readonly wakePace = new WakePace();
	protected readonly delivery: Delivery;
	/** This agent's status, tool counts and usage, written with the heartbeat (`session/activity.ts`). */
	protected readonly activity: Activity;
	/** Stops the check that the parent still runs (a subagent only; on from the session start, joined or not). */
	protected stopParentWatch: (() => void) | undefined;
	/** Subagents this session started that have finished: id → where their report went, for a later message to them. */
	protected readonly finished = new Map<string, string>();
	protected readonly runnerTasks = new Map<string, { active: boolean; mail: boolean }>();
	/** Runner sessions are one turn: retain their capability beside recent completion receipts. */
	trackRunner(id: string, mail: boolean): () => void {
		const entry = { active: true, mail };
		this.runnerTasks.set(id, entry);
		return () => {
			entry.active = false;
			const inactive = [...this.runnerTasks].filter(([, state]) => !state.active);
			for (const [old] of inactive.slice(0, -RECENT_FINISHED_LIMIT)) this.runnerTasks.delete(old);
		};
	}
	/** Resumes a finished subagent that still lingers; `running` holds the subagents that have yet to report, by id (set by the subagents domain). */
	setResumer(resume: Resumer, running?: ReadonlyMap<string, unknown>): void {
		this.resumer = resume;
		this.running = running;
	}
	protected resumer: Resumer | undefined;
	protected running: ReadonlyMap<string, unknown> | undefined;
	protected messageHook: MessageHook | undefined;
	setMessageHook(hook: MessageHook): void {
		this.messageHook = hook;
	}
	/** Settles children's relay requests to agents they cannot reach, before mail reaches the model. */
	protected readonly relays = new Relays({
		id: () => this.me?.id,
		finished: this.finished,
		started: (id) => this.finished.has(id) || this.vouches.has(id),
		resumer: () => this.resumer,
	});
	/** Recent completion receipts; active-agent limits cannot bound a long session's history. */
	rememberFinished(id: string, receipt: string): void {
		this.finished.delete(id);
		this.finished.set(id, receipt);
		if (this.finished.size > RECENT_FINISHED_LIMIT) this.finished.delete(this.finished.keys().next().value!);
	}
	/** Join (or refresh) as this process; the reservation host calls it before the first lock. */
	abstract join(goal?: string): Member;
	/** Hands waiting mail to Octocode; the ticker calls it every second. */
	abstract deliverMail(stepEnded?: boolean): void;
	protected readonly env: NodeJS.ProcessEnv;
	protected readonly name: SessionTeamName;
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
				recipientKind: (id) => ({
					child: this.finished.has(id) || this.vouches.has(id) || this.running?.has(id) === true,
					reported: this.finished.has(id),
				}),
				checkIn: () => checkInConfig(api.getSettings().subagents, this.env, api),
			},
			this.mail,
			this.wakePace,
		);
	}
	protected readonly vouches = new Vouches();
	readonly approvals = new WaitingApprovals();
	/** Registers the secret given to subagent `id` (its `PERMISSION_NONCE_FILE_ENV` file), so the user's messages to it are signed; returns what ends that. */
	vouch(id: string, secret: string): () => void {
		return this.vouches.vouch(id, secret);
	}

	get id(): string | undefined {
		return this.me?.id;
	}

	get parentId(): string | undefined {
		return this.env[PARENT_ID_ENV];
	}

	/** The team as sending and references see it (`session/send.ts`, `session/references.ts`). */
	protected sendHost(): ReferenceHost {
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
			runner: (id) => this.runnerTasks.get(id),
		};
	}

	/** The team as path reservations see it (`session/reservations.ts`). */
	protected reservationHost(): ReservationHost {
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

	/** A subagent (no person to talk to, whatever its mode): once its run is over it gets no further turn. */
	protected headless(): boolean {
		return Boolean(this.env[AGENT_ID_ENV] && this.ctx && !interactive(this.ctx, envFlag(this.env, SUBAGENT_ENV)));
	}
}
