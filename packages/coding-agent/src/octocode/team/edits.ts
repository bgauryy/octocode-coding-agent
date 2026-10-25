import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../agentdb/rows.ts";
import { canonicalPath } from "../shared/home/repo.ts";
import { DAY_MS, MINUTE_MS } from "../shared/util.ts";

/** Who changed which file, kept a day in the team database, for `coordinate changes`. */

/** One file's changes in the window: every agent and tool that changed it (latest first), when it last changed, and how many changes it had. */
export interface Change {
	/** Relative to the workspace, `/`-separated. */
	path: string;
	agents: string[];
	tools: string[];
	at: number;
	count: number;
}

/** What a session's writes are recorded under until it has a team name (it joins later; see `EditLog.adopt`). */
export const unjoinedAgent = (): string => `pid ${process.pid}`;

/** How long a change is kept; a longer `coordinate changes` window cannot be answered. */
export const EDIT_RETENTION_MINUTES = DAY_MS / MINUTE_MS;
const EDIT_RETENTION_MS = DAY_MS;

export class EditLog {
	private readonly db: DatabaseSync;
	readonly workspace: string;
	constructor(db: DatabaseSync, workspace: string) {
		this.db = db;
		this.workspace = workspace;
	}

	/** Records that `agent` changed `files` (absolute) with `tool`; files outside the workspace are skipped. */
	record(agent: string, tool: string, files: string[], now = Date.now()): void {
		const insert = this.db.prepare("INSERT INTO edits (workspace, path, agent, tool, at) VALUES (?, ?, ?, ?, ?)");
		for (const file of files) {
			const relative = path.relative(this.workspace, canonicalPath(path.resolve(this.workspace, file)));
			if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
			insert.run(this.workspace, relative.split(path.sep).join("/"), agent, tool, now);
		}
	}

	/**
	 * Files agents changed in the last `withinMs`, newest first, one row per file (all its writers and tools, its latest
	 * change and the count), optionally only under `prefixes` (workspace-relative, `/`-separated) and only by `agent`.
	 */
	changes(options: { withinMs: number; prefixes?: string[]; agent?: string }, now = Date.now()): Change[] {
		const byAgent = options.agent === undefined ? "" : " AND agent = ?";
		const rows = this.db
			.prepare(
				// Writes within one millisecond share `at`; the row id, assigned in insertion order, decides which is newer.
				`SELECT path, agent, tool, MAX(at) AS at, COUNT(*) AS count, MAX(rowid) AS seq FROM edits WHERE workspace = ? AND at > ?${byAgent} GROUP BY path, agent, tool ORDER BY at DESC, seq DESC, path`,
			)
			.all(this.workspace, now - options.withinMs, ...(options.agent === undefined ? [] : [options.agent])) as Row[];
		const prefixes = options.prefixes?.map((prefix) => prefix.replace(/\/+$/, ""));
		const under = (file: string) =>
			!prefixes?.length || prefixes.some((prefix) => prefix === "" || file === prefix || file.startsWith(`${prefix}/`));
		const byPath = new Map<string, Change>();
		for (const row of rows) {
			const file = String(row.path);
			if (!under(file)) continue;
			const agent = String(row.agent);
			const tool = String(row.tool);
			const found = byPath.get(file);
			if (!found) {
				byPath.set(file, { path: file, agents: [agent], tools: [tool], at: num(row.at), count: num(row.count) });
				continue;
			}
			// Rows arrive newest first, so the first sighting of an agent or tool is its latest.
			if (!found.agents.includes(agent)) found.agents.push(agent);
			if (!found.tools.includes(tool)) found.tools.push(tool);
			found.count += num(row.count);
		}
		return [...byPath.values()].sort((left, right) => right.at - left.at || left.path.localeCompare(right.path));
	}

	/**
	 * Gives this process's writes from before it had a team name (recorded under `unjoinedAgent`) to `agent`, so a session
	 * that joins after editing still owns what it wrote. Only rows since the process started move: an older row with the
	 * same pid is another process's. A failure leaves the pid label, which only makes the attribution less precise.
	 */
	adoptUnjoined(agent: string): void {
		try {
			this.db
				.prepare("UPDATE edits SET agent = ? WHERE workspace = ? AND agent = ? AND at >= ?")
				.run(agent, this.workspace, unjoinedAgent(), Date.now() - Math.ceil(process.uptime() * 1000));
		} catch {
			/* keep the pid label */
		}
	}

	/** Drops rows past retention; the team store runs it with its periodic prune (on heartbeats), not on every edit. */
	prune(now = Date.now()): void {
		this.db.prepare("DELETE FROM edits WHERE at < ?").run(now - EDIT_RETENTION_MS);
	}
}
