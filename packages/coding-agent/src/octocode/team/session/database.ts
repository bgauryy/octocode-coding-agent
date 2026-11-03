import fs from "node:fs";
import type { ExtensionContext } from "../../../core/features/index.ts";
import { AgentDbError } from "../../../../../db/src/api.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { agentDbPath } from "../../shared/home.ts";
import type { Ask } from "../asks.ts";
import type { OpenQuestion } from "../model.ts";
import { TeamStore } from "../store.ts";
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
	/** Why the database cannot be used at all (a foreign file); shown in /agents and the footer. */
	private schemaProblem: string | undefined;

	constructor(host: DatabaseHost) {
		this.host = host;
	}

	/** The database this session opened, if it used one yet. */
	get current(): TeamStore | undefined {
		return this.db;
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
		this.db = undefined;
	}

	/** The database opens on first use, so a session that never collaborates never creates it. */
	store(): TeamStore {
		const ctx = this.host.ctx();
		if (!ctx) throw new Error("The team is not available before the session starts.");
		if (this.schemaProblem) throw new Error(this.schemaProblem);
		try {
			this.db ??= TeamStore.shared(ctx.cwd, this.host.env());
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
