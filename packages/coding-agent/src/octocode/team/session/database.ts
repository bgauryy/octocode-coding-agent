import fs from "node:fs";
import type { ExtensionContext } from "../../../core/features/index.ts";
import { type agentEvents, AgentDbError } from "../../../../../db/src/api.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { agentDbPath } from "../../shared/home.ts";
import type { Ask } from "../asks.ts";
import type { OpenQuestion } from "../model.ts";
import { AGENT_LIFECYCLE_CHANNEL } from "../../shared/agent-lifecycle.ts";
import { AgentLifecycleBus } from "../lifecycle-bus.ts";
import type { PeerNoticeHost } from "../peer-left.ts";
import { TeamStore } from "../store.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { TeamView } from "../ticker.ts";

/** What the database access reads of the team (`Team`, `session.ts`): the current values each time. */
interface DatabaseHost {
	ctx(): ExtensionContext | undefined;
	env(): NodeJS.ProcessEnv;
}

/** The team database as one session uses it: opened on first use, never created by a read, refused once found foreign. */
export class TeamDatabase {
	private readonly host: DatabaseHost;
	private db: TeamStore | undefined;
	private stopWrites: (() => void) | undefined;
	private stopForward: (() => void) | undefined;
	private events: { emit(channel: string, data: unknown): void } | undefined;
	/** Every agent's join, state change and end, whichever process wrote it (`lifecycle-bus.ts`); the ticker feeds it when the database changes. */
	readonly lifecycle: AgentLifecycleBus;
	/** Why the database cannot be used at all (a foreign file); shown in /agents and the footer. */
	private schemaProblem: string | undefined;

	/** `sync`: the lifecycle bus gained or lost its last listener, so the ticker starts or stops following the database. */
	constructor(host: DatabaseHost, sync: () => void) {
		this.host = host;
		this.lifecycle = new AgentLifecycleBus({
			head: () => this.eventsHead(),
			since: (after) => this.eventsSince(after),
			sync,
		});
	}

	/** Announces what this process writes (agents joining and ending) on the session's event channel, for the AgentOn and AgentOff hooks. */
	forwardTo(events: { emit(channel: string, data: unknown): void }): void {
		this.events = events;
	}

	/** The database this session opened, if it used one yet. */
	get current(): TeamStore | undefined {
		return this.db;
	}

	/** What the peer-left notices read (`peer-left.ts`) for the agent `self` names: the bus and the records of the database opened so far. */
	peers(self: () => string | undefined): Omit<PeerNoticeHost, "mail"> {
		return { bus: this.lifecycle, self, db: () => this.db?.refs };
	}

	/** Set when the team database is foreign or too new; nothing team-related works until it is fixed. */
	get problem(): string | undefined {
		return this.schemaProblem;
	}

	/** A new session checks the database again. */
	clearProblem(): void {
		this.schemaProblem = undefined;
	}

	/** Lets go of the database (session end; the process connection stays open for the next session). */
	release(): void {
		this.stopWrites?.();
		this.stopForward?.();
		this.stopWrites = undefined;
		this.stopForward = undefined;
		this.db = undefined;
	}

	/** The database opens on first use, so a session that never collaborates never creates it. */
	store(): TeamStore {
		const ctx = this.host.ctx();
		if (!ctx) throw new Error("The team is not available before the session starts.");
		if (this.schemaProblem) throw new Error(this.schemaProblem);
		try {
			if (!this.db) {
				this.db = TeamStore.shared(ctx.cwd, this.host.env());
				// A write of this connection is announced at once: an agent that leaves and exits has no later tick.
				this.stopWrites = this.db.presence.onWrite((from, to) => {
					this.lifecycle.wrote(from, to);
					this.lifecycle.poll();
				});
				const { events } = this;
				if (events)
					this.stopForward = this.lifecycle.on(
						(event) => event.kind !== "state" && events.emit(AGENT_LIFECYCLE_CHANNEL, event),
						{ others: false },
					);
			}
			return this.db;
		} catch (error) {
			const problem = `Team database unavailable: ${errorMessage(error)}`;
			if (error instanceof AgentDbError) this.schemaProblem = problem;
			throw new Error(problem, { cause: error });
		}
	}

	/**
	 * The database only if someone already created it: reads never create it, since before anyone has collaborated
	 * there is nothing to read. Throws when it exists but is unusable.
	 */
	existing(): TeamStore | undefined {
		return this.db || fs.existsSync(agentDbPath(this.host.env())) ? this.store() : undefined;
	}

	/** Live agents and the latest messages between them, from one read. */
	snapshot(): TeamView {
		try {
			const db = this.existing();
			return db ? { members: db.list(), traffic: db.recent() } : { members: [], traffic: [] };
		} catch (error) {
			if (this.schemaProblem) return { members: [], traffic: [], error: this.schemaProblem };
			return {
				members: [],
				traffic: [],
				error: `Team database unavailable: ${errorMessage(error)}`,
				retrying: true,
			};
		}
	}

	/** Agents whose process runs but who have not been seen for `STALE_MS` (hidden from `snapshot`); none when the database cannot be read. */
	stalled(): Member[] {
		try {
			return this.existing()?.list(Date.now(), true) ?? [];
		} catch {
			return [];
		}
	}

	/** The file the ticker watches: only once the session started and the database is open or exists. */
	watchedFile(): string | undefined {
		const file = agentDbPath(this.host.env());
		return this.host.ctx() && (this.db || fs.existsSync(file)) ? file : undefined;
	}

	/** The ticker's read: a snapshot that never waits long for another process's lock. */
	read(): TeamView {
		// Reads never write, but share the connection's busy wait: never wait long for another process's lock.
		return this.db ? this.db.quick(() => this.snapshot()) : this.snapshot();
	}

	/** The machine slept (or this process stalled) from `since` to `now`: the existing database gives its members and leases a fresh start. */
	resumed(since: number, now: number): void {
		try {
			this.existing()?.resume(since, now);
		} catch {
			// Unusable database: the snapshot says why; nothing to repair.
		}
	}

	/** The newest presence event now: 0 when there is no database or it cannot be read. */
	eventsHead(): number {
		try {
			return this.existing()?.presence.head() ?? 0;
		} catch {
			return 0;
		}
	}

	/** Presence events after `after`; none when the database cannot be read (the next change retries). */
	eventsSince(after: number): agentEvents.EventRow[] {
		try {
			return this.existing()?.presence.since(after) ?? [];
		} catch {
			return [];
		}
	}

	/**
	 * The questions `child` sent its `parent` since `since`, with their answers. None when the database cannot be read:
	 * this is a measurement, so it never fails the run it describes.
	 */
	asks(child: string, parent: string, since: number): Ask[] {
		try {
			return this.existing()?.asks(child, parent, since) ?? [];
		} catch {
			return [];
		}
	}

	/** The team's read, unanswered questions for `coordinate list`; none when the database cannot be read (the snapshot says why). */
	openQuestions(): OpenQuestion[] {
		try {
			return this.existing()?.refs.openQuestions() ?? [];
		} catch {
			return [];
		}
	}
}
