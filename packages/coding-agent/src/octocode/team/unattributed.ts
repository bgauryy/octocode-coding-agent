import { stat } from "node:fs/promises";
import path from "node:path";
import type { EditLog } from "./edits.ts";
import { EXCLUDE_WORKSPACE_STATE, git, GitError } from "../../utils/git-run.ts";

/** A path git reports changed that no agent recorded: written by an editor, git, a script or a command whose writes cannot be named. */
export interface Unattributed {
	/** Relative to the workspace, `/`-separated. */
	path: string;
	/** `A`, `M`, `D`, `R` or `untracked`. */
	status: string;
	/** Last modification time (ms since epoch); undefined for a deleted path. */
	mtime?: number;
}

const code = (xy: string): string => (xy === "??" ? "untracked" : xy[0] !== " " ? (xy[0] ?? "M") : (xy[1] ?? "M"));

/**
 * Paths `git status` reports changed in `workspace` whose modification time is at or after `since`, minus `recorded`
 * (workspace-relative paths with an `edits` row in the window), narrowed to `prefixes` when given. One `git status` per
 * call; a deleted path has no mtime and is listed whenever git reports it. Rejects when git cannot read the workspace.
 */
async function unattributedChanges(
	workspace: string,
	options: { since: number; recorded: ReadonlySet<string>; prefixes?: string[] },
): Promise<Unattributed[]> {
	const [top, out] = await Promise.all([
		git(workspace, ["rev-parse", "--show-toplevel"]),
		git(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...EXCLUDE_WORKSPACE_STATE], {
			raw: true,
			env: { GIT_OPTIONAL_LOCKS: "0" },
		}),
	]);
	const prefixes = options.prefixes?.map((prefix) => prefix.replace(/\/+$/, ""));
	const fields = out.split("\0");
	const found: Unattributed[] = [];
	for (let at = 0; at < fields.length; at++) {
		const field = fields[at] ?? "";
		if (field.length < 4) continue;
		const xy = field.slice(0, 2);
		if (xy[0] === "R" || xy[0] === "C") at++; // a rename lists its source as a second field
		const relative = path
			.relative(workspace, path.join(top, field.slice(3)))
			.split(path.sep)
			.join("/");
		if (relative.startsWith("..") || options.recorded.has(relative)) continue;
		if (prefixes && !prefixes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) continue;
		const status = code(xy);
		try {
			const mtime = (await stat(path.join(workspace, relative))).mtimeMs;
			if (mtime >= options.since) found.push({ path: relative, status, mtime });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			found.push({ path: relative, status });
		}
	}
	return found.sort((a, b) => (b.mtime ?? Infinity) - (a.mtime ?? Infinity));
}

/**
 * The unattributed changes of the last `minutes` in the log's workspace (those the log has a row for are attributed), or
 * git's own reason when it cannot read the workspace (not a repository, say): the agents' changes are still listed.
 */
export async function outsideAgents(
	log: EditLog,
	minutes: number,
	prefixes: string[] | undefined,
	now: number,
): Promise<Unattributed[] | string> {
	const withinMs = minutes * 60_000;
	const recorded = new Set(log.changes({ withinMs }, now).map((change) => change.path));
	try {
		return await unattributedChanges(log.workspace, {
			since: now - withinMs,
			recorded,
			...(prefixes?.length ? { prefixes } : {}),
		});
	} catch (error) {
		if (error instanceof GitError) return error.message;
		throw error;
	}
}
