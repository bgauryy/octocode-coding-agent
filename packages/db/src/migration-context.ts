import type { DatabaseSync } from "node:sqlite";

/** A connection on another file of this database that a migration step writes, with its own transactions. */
export interface MigrationStore {
	readonly db: DatabaseSync;
	transaction<T>(fn: () => T): T;
	close(): void;
}

/** What a migration step may use besides the file it migrates. */
export interface MigrationContext {
	/** Opens the transcript mirror file (`transcripts.db`), creating its schema when it is new; the step closes it. */
	openMirror(): MigrationStore;
	/** Called after each session a long step finished, with how many it has done: progress for a runner, a cut point for tests. */
	progress?(done: number, total: number): void;
}
