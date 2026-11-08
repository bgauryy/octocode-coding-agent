import path from "node:path";
import { type Db, edits, num, workspaces } from "../../../../db/src/api.ts";
import { formatAgo } from "../shared/format.ts";
import { DAY_MS, MINUTE_MS } from "../shared/util.ts";
import { canonicalIn } from "./store/workspace.ts";

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

/** How far back `changeNote` looks for the file's last change. */
const NOTE_WINDOW_MS = 60 * MINUTE_MS;

/**
 * Who last changed `file` (absolute) according to the log, as a sentence for a changed-on-disk refusal; undefined without a
 * log or outside the workspace. `self`: this session's own name, so its own writes read as such.
 */
export function changeNote(
	log: EditLog | undefined,
	file: string,
	self: string | undefined,
	now = Date.now(),
): string | undefined {
	if (!log) return undefined;
	const relative = path.relative(log.workspace, canonicalIn(log.workspace, file)).split(path.sep).join("/");
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	const change = log
		.changes({ withinMs: NOTE_WINDOW_MS, prefixes: [relative] }, now)
		.find((row) => row.path === relative);
	if (!change) {
		return "No agent change to it is recorded in the last hour, so an editor, git, a formatter or another process wrote it.";
	}
	const me = self ?? unjoinedAgent();
	const others = change.agents.filter((agent) => agent !== me);
	const how = `${change.tools.join(", ")}, ${formatAgo(now - change.at)}`;
	return others.length > 0
		? `Last recorded change: ${others.join(", ")} (${how}).`
		: `Its last recorded change is this session's own (${how}); another process may also have written it.`;
}

/** A file whose latest recorded change is another agent's: `agent` wrote it `ago` ago (display form). */
export interface OtherChange {
	/** As named by the caller. */
	file: string;
	agent: string;
	ago: string;
}

/**
 * Which of `files` (absolute) another agent changed last, in the last hour, by one read of the log. A file this session
 * wrote last, one outside the workspace and one with no recorded change are left out: only another agent's change names a
 * likely cause. Empty without a log.
 */
export function changesByOthers(
	log: EditLog | undefined,
	files: string[],
	self: string | undefined,
	now = Date.now(),
): OtherChange[] {
	if (!log || files.length === 0) return [];
	const root = log.workspace;
	const named = new Map<string, string>();
	for (const file of files) {
		const relative = path.relative(root, canonicalIn(root, file)).split(path.sep).join("/");
		if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) named.set(relative, file);
	}
	const me = self ?? unjoinedAgent();
	return log.changes({ withinMs: NOTE_WINDOW_MS, prefixes: [...named.keys()] }, now).flatMap((change) => {
		const file = named.get(change.path);
		return file !== undefined && change.agents[0] !== me
			? [{ file, agent: change.agents[0], ago: formatAgo(now - change.at) }]
			: [];
	});
}

/** What a session's writes are recorded under until it has a team name (it joins later; see `EditLog.adopt`). */
export const unjoinedAgent = (): string => `pid ${process.pid}`;

/** How long a change is kept; a longer `coordinate changes` window cannot be answered. */
export const EDIT_RETENTION_MINUTES = DAY_MS / MINUTE_MS;
const EDIT_RETENTION_MS = DAY_MS;

export class EditLog {
	private readonly db: Db;
	readonly workspaceId: string;
	get workspace(): string {
		const checkout = workspaces.byId(this.db, this.workspaceId);
		if (!checkout) throw new Error(`Unknown reservation workspace: ${this.workspaceId}`);
		return checkout.root;
	}
	constructor(db: Db, workspaceId: string) {
		this.db = db;
		this.workspaceId = workspaceId;
	}

	/** Records that `agent` changed `files` (absolute) with `tool`; files outside the workspace are skipped. */
	record(agent: string, tool: string, files: string[], now = Date.now()): void {
		const root = this.workspace;
		const relatives: string[] = [];
		for (const file of files) {
			const relative = path.relative(root, canonicalIn(root, file));
			if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
			relatives.push(relative.split(path.sep).join("/"));
		}
		edits.record(this.db, this.workspaceId, relatives, agent, tool, now);
	}

	/**
	 * Files agents changed in the last `withinMs`, newest first, one row per file (all its writers and tools, its latest
	 * change and the count), optionally only under `prefixes` (workspace-relative, `/`-separated) and only by `agent`.
	 */
	changes(options: { withinMs: number; prefixes?: string[]; agent?: string }, now = Date.now()): Change[] {
		const rows = edits.changesSince(this.db, this.workspaceId, now - options.withinMs, options.agent);
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
			edits.reassign(
				this.db,
				this.workspaceId,
				unjoinedAgent(),
				agent,
				Date.now() - Math.ceil(process.uptime() * 1000),
			);
		} catch {
			/* keep the pid label */
		}
	}

	/** Drops rows past retention; the team store runs it with its periodic prune (on heartbeats), not on every edit. */
	prune(now = Date.now()): void {
		edits.pruneBefore(this.db, now - EDIT_RETENTION_MS);
	}
}
