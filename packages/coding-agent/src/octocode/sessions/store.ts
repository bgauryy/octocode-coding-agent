import type { SessionExtra } from "../agentdb/queries/sessions.ts";
export type { SessionExtra };
import { execFile } from "node:child_process";
import type { AgentDb } from "../agentdb/db.ts";
import { meta, sessions } from "../agentdb/api.ts";
import { processStartTime } from "../shared/process.ts";
import { sanitizeTerminalText } from "../shared/sanitize.ts";

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
const git = (cwd: string, args: string[]) =>
	new Promise<string>((resolve, reject) => {
		execFile("git", args, { cwd, encoding: "utf8", timeout: 2000, windowsHide: true }, (error, stdout) =>
			error ? reject(error) : resolve(stdout),
		);
	});

/**
 * The checked-out branch of `cwd` (`HEAD` short name; undefined on a detached HEAD) and the HEAD commit; both undefined
 * outside git or before the first commit. Never rejects.
 */
export async function gitState(cwd: string): Promise<{ branch?: string; head?: string }> {
	try {
		const [head = "", branch = ""] = (await git(cwd, ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"])).trim().split("\n");
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
		return (await git(cwd, ["status", "--porcelain"])).split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

/** Commits from `from` to `to`, or undefined when git cannot tell (e.g. `from` was rewritten away). Never rejects. */
export async function gitCommitsBetween(cwd: string, from: string, to: string): Promise<number | undefined> {
	try {
		return Number((await git(cwd, ["rev-list", "--count", `${from}..${to}`])).trim());
	} catch {
		return undefined;
	}
}

/** The session extras: one row per Octocode session this extension has run. */
export class SessionIndex {
	readonly agent: AgentDb;
	constructor(agent: AgentDb) {
		this.agent = agent;
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

	/** This process has the session open now, from session dir `dir` when known. Keeps what earlier runs recorded. */
	start(id: string, dir?: string): void {
		sessions.start(this.agent.db, id, process.pid, processStartTime(process.pid) ?? null, dir ?? null);
	}

	stats(id: string, stats: SessionStats): void {
		sessions.saveStats(this.agent.db, id, {
			cost: stats.cost,
			tokens: stats.tokens,
			filesChanged: stats.filesChanged,
			unpriced: stats.unpriced,
			branch: stats.branch ?? null,
			head: stats.head ?? null,
			pid: process.pid,
			pidStarted: processStartTime(process.pid) ?? null,
		});
	}

	/** Records where git stood, without touching the stats. */
	git(id: string, state: { branch?: string; head?: string }): void {
		sessions.saveGit(this.agent.db, id, state.branch ?? null, state.head ?? null);
	}

	/** The session's process has ended: it is no longer live. */
	end(id: string): void {
		sessions.clearPid(this.agent.db, id, process.pid);
	}

	all(): SessionExtra[] {
		return sessions.all(this.agent.db);
	}

	forget(id: string): void {
		sessions.forget(this.agent.db, id);
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
