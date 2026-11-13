import { shellHistory } from "../../../../db/src/api.ts";
import type { HistoryEntry } from "../../../../terminal/src/index.ts";
import { sharedAgentDb } from "../../storage/database.ts";

/** Commands kept in the database; older ones are dropped as new ones are recorded. */
const KEEP = 5000;
/** Commands loaded for ranking. */
const LOAD = 2000;

/**
 * The user's `!` commands in the agent database, shared by every session. A failed read or write leaves the editor
 * without history suggestions; it never stops a command.
 */
export class ShellHistoryStore {
	private cache: HistoryEntry[] | undefined;
	private prefetch: NodeJS.Immediate | undefined;
	private writes = 0;
	private readonly env: NodeJS.ProcessEnv;

	constructor(env: NodeJS.ProcessEnv = process.env) {
		this.env = env;
	}

	entries(): HistoryEntry[] {
		if (this.cache) return this.cache;
		this.load();
		return this.cache ?? [];
	}

	private load(): void {
		try {
			this.cache = shellHistory.recent(sharedAgentDb(this.env).db, LOAD).map((row) => ({
				command: row.command,
				cwd: row.cwd,
				count: row.count,
				lastAt: row.last_at,
				lastExit: row.last_exit,
			}));
		} catch {
			this.cache = [];
		}
	}

	/**
	 * A recorded run changed the ranking: drop the cached entries and read them again once the current work is done, so
	 * the first key of the next `!` line does not wait for the database. A key that comes first reads them itself.
	 */
	private refresh(): void {
		this.cache = undefined;
		if (this.prefetch) return;
		this.prefetch = setImmediate(() => {
			this.prefetch = undefined;
			if (!this.cache) this.load();
		});
		this.prefetch.unref();
	}

	/** Counts a run of `command` in `cwd`. */
	record(cwd: string, command: string, at = Date.now()): void {
		try {
			const db = sharedAgentDb(this.env).db;
			shellHistory.record(db, cwd, command, at);
			if (++this.writes % 100 === 1) shellHistory.prune(db, KEEP);
		} catch {
			// History is a convenience.
		}
		this.refresh();
	}

	/** Stores how the last run of `command` in `cwd` exited. */
	setExit(cwd: string, command: string, exit: number): void {
		try {
			shellHistory.setExit(sharedAgentDb(this.env).db, cwd, command, exit);
		} catch {
			// History is a convenience.
		}
		this.refresh();
	}
}
