export type { CatalogEntry, CatalogRow, SessionExtra, SessionLinks };
import {
	type AgentDb,
	type CatalogEntry,
	type DbWriter,
	type CatalogRow,
	meta,
	type SessionExtra,
	type SessionLinks,
	sessionLinks,
	sessions,
} from "../../../../db/src/api.ts";
import { agentDbWriter } from "../../storage/database.ts";
import { EXCLUDE_WORKSPACE_STATE, git } from "../../utils/git-run.ts";
import { processStartTime } from "../shared/process.ts";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";

interface SessionStats {
	cost: number;
	tokens: number;
	filesChanged: number;
	/** Part of the usage came from a model without pricing. */
	unpriced: boolean;
	branch?: string;
	head?: string;
}

/** Text on one line, whole: terminal controls stripped, whitespace collapsed. The form text for the model takes. */
export const flatLine = (text: string): string => sanitizeTerminalText(text).replace(/\s+/g, " ").trim();

/** `flatLine` of at most `max` characters, for a terminal row. */
export function shownLine(text: string, max: number): string {
	// By code point, so a cut never splits a surrogate pair (an emoji).
	// oxlint-disable-next-line typescript/no-misused-spread -- a code-point cut is intended, as the comment above says
	const line = [...flatLine(text)];
	return line.length > max ? `${line.slice(0, max - 1).join("")}…` : line.join("");
}

/** Runs git off the event loop; rejects on failure or after 2 s. */
const sessionGit = (cwd: string, args: string[]) => git(cwd, args, { timeoutMs: 2000 });

/**
 * The checked-out branch of `cwd` (`HEAD` short name; undefined on a detached HEAD) and the HEAD commit; both undefined
 * outside git or before the first commit. Never rejects.
 */
export async function gitState(cwd: string): Promise<{ branch?: string; head?: string }> {
	try {
		const [head = "", branch = ""] = (await sessionGit(cwd, ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"]))
			.trim()
			.split("\n");
		return {
			...(branch && branch !== "HEAD" ? { branch: shownLine(branch, 120) } : {}),
			...(/^[0-9a-f]{7,64}$/.test(head) ? { head } : {}),
		};
	} catch {
		return {};
	}
}

/** Changed or untracked paths in the working tree of `cwd` (0 outside git or when git is slow). Never rejects. */
export async function gitDirty(cwd: string): Promise<number> {
	try {
		return (await sessionGit(cwd, ["status", "--porcelain", "--", ...EXCLUDE_WORKSPACE_STATE]))
			.split("\n")
			.filter(Boolean).length;
	} catch {
		return 0;
	}
}

/** Commits from `from` to `to`, or undefined when git cannot tell (e.g. `from` was rewritten away). Never rejects. */
export async function gitCommitsBetween(cwd: string, from: string, to: string): Promise<number | undefined> {
	try {
		return Number((await sessionGit(cwd, ["rev-list", "--count", `${from}..${to}`])).trim());
	} catch {
		return undefined;
	}
}

/** The session extras: one row per Octocode session this feature has run. */
export class SessionIndex {
	readonly agent: AgentDb;
	/** The writer of the same database file: the per-turn bookkeeping (`…Later`) goes there, off this thread. */
	private readonly writer: () => DbWriter;
	constructor(agent: AgentDb, writer?: () => DbWriter) {
		this.agent = agent;
		this.writer = writer ?? (() => agentDbWriter(agent));
	}

	/*
	 * The writes a live session makes after every turn and at its end (`…Later`: usage, git state, catalog row, name,
	 * end) go through the database writer in the order asked: this thread never waits for another process's write lock.
	 * Each resolves after its commit and rejects when the writer could not run it.
	 */

	statsLater(id: string, stats: SessionStats): Promise<void> {
		return this.writer().post({ kind: "session-stats", id, stats: statsRow(stats) });
	}

	/** Records where git stood, without touching the stats. */
	gitLater(id: string, state: { branch?: string; head?: string }): Promise<void> {
		return this.writer().post({ kind: "session-git", id, branch: state.branch ?? null, head: state.head ?? null });
	}

	/** `saveCatalog` through the writer. */
	catalogLater(id: string, entry: CatalogEntry): Promise<void> {
		return this.writer().post({ kind: "session-catalog", id, entry });
	}

	/** Records session `id`'s new name (undefined clears it) and the file's modification time after the name was written. */
	titleLater(
		id: string,
		title: string | undefined,
		source: string | undefined,
		fileMtime: number | null,
	): Promise<void> {
		return this.writer().post({ kind: "session-title", id, ...titleRow(title, source), fileMtime });
	}

	/** `end` through the writer, after this session's writes still queued. */
	endLater(id: string): Promise<void> {
		return this.writer().post({ kind: "session-end", id, pid: process.pid });
	}

	get(id: string): SessionExtra | undefined {
		return sessions.byId(this.agent.db, id);
	}

	/** Extras of the given sessions, by id. */
	extras(ids: readonly string[]): Map<string, SessionExtra> {
		const rows = new Map<string, SessionExtra>();
		for (const id of ids) {
			const row = sessions.byId(this.agent.db, id);
			if (row) rows.set(id, row);
		}
		return rows;
	}

	/** What the database links to each of the given sessions: the `ongoing` backlog items it holds and the team agent it runs as. */
	links(ids: readonly string[]): Map<string, SessionLinks> {
		return sessionLinks.linksOf(this.agent.db, ids);
	}

	/** Ids of the sessions that held or hold item `B<seq>` (of repository `repo`, or of any without it). */
	heldItem(seq: number, repo?: string): Set<string> {
		return new Set(sessionLinks.heldItem(this.agent.db, seq, repo));
	}

	/** This process has the session open now, from session dir `dir` when known. Keeps what earlier runs recorded. */
	start(id: string, dir?: string): void {
		sessions.start(this.agent.db, id, process.pid, processStartTime(process.pid) ?? null, dir ?? null);
	}

	/** The session's process has ended: it is no longer live. */
	end(id: string): void {
		sessions.clearPid(this.agent.db, id, process.pid);
	}

	/** The catalog rows (sessions with a recorded file), those of sessions that ran in `scope.cwd` when given. */
	catalog(scope: { cwd?: string } = {}): CatalogRow[] {
		return sessions.catalog(this.agent.db, scope.cwd);
	}

	/** Records what the transcript of session `id` says (its name, first prompt, size and times) for a quick listing. */
	saveCatalog(id: string, entry: CatalogEntry): void {
		sessions.saveCatalog(this.agent.db, id, entry);
	}

	all(): SessionExtra[] {
		return sessions.all(this.agent.db);
	}

	forget(id: string): void {
		sessions.forget(this.agent.db, this.agent.mirror.db, id);
	}

	/** Removes everything the database holds for the given sessions, mirror included (`sessions.erase`). */
	erase(ids: readonly string[]): void {
		sessions.erase(this.agent.db, this.agent.mirror.db, ids);
	}

	/** Session dirs other than Octocode's default that a session ran from (meta `session_dirs`): the sweep lists their sessions too. */
	sessionDirs(): string[] {
		try {
			const dirs: unknown = JSON.parse(meta.read(this.agent.db, SESSION_DIRS_KEY) ?? "[]");
			return Array.isArray(dirs) ? dirs.filter((dir): dir is string => typeof dir === "string") : [];
		} catch {
			return [];
		}
	}

	addSessionDir(dir: string): void {
		this.agent.transaction(() => {
			const dirs = this.sessionDirs();
			if (!dirs.includes(dir)) meta.write(this.agent.db, SESSION_DIRS_KEY, JSON.stringify([...dirs, dir]));
		});
	}
}

const SESSION_DIRS_KEY = "session_dirs";

/** The stored stats of this process's session. */
const statsRow = (stats: SessionStats) => ({
	cost: stats.cost,
	tokens: stats.tokens,
	filesChanged: stats.filesChanged,
	unpriced: stats.unpriced,
	branch: stats.branch ?? null,
	head: stats.head ?? null,
	pid: process.pid,
	pidStarted: processStartTime(process.pid) ?? null,
});

/** A name and who gave it (`user` unless said); both null clear it. */
const titleRow = (title: string | undefined, source: string | undefined) => ({
	title: title ?? null,
	source: title ? (source ?? "user") : null,
});
