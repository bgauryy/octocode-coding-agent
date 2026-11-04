import fs from "node:fs";
import path from "node:path";
import { agents, workspaces } from "../../../../db/src/api.ts";
import { canonicalPath } from "../../../../common/src/canonical-path.ts";
import { isUnderPath } from "../../../../common/src/paths.ts";
import { getSessionsDir } from "../../config.ts";
import { agentDbPath } from "../../config/state-paths.ts";
import { WORKSPACE_STATE, workspaceDataRoot } from "../../config/workspace.ts";
import { readSessionHeaderForDiscovery, getSessionHeaderCwd } from "../../core/session-manager/storage.ts";
import { globalPaths, octocodeTmpDir, sessionDirName, workspaceOctocodeDir } from "../shared/home.ts";
import { sameProcess } from "../shared/process.ts";
import { realDirectory, pathSize, strictlyInside } from "./sweep-fs.ts";
import { running } from "./sweep-listing.ts";
import type { SessionIndex } from "./store.ts";

/** What `/purge` removes, planned first (`planPurge`, shown as the preview) and then applied (`applyPurge`). */

export type PurgeScope = "workspace" | "all";

export type PurgeKind =
	/** A session transcript (JSONL) in a workspace's `.octocode/code/sessions`. */
	| "transcript"
	/** A transcript in the legacy per-folder directories of the agent home. */
	| "legacy-transcript"
	/** An entry of `.octocode/code/session-data` or of the global `agent/sessions`. */
	| "session-data"
	/** An entry of `.octocode/code/temp` (session temp, subagent scratch). */
	| "temp"
	/** An entry of `<root>/.octocode/tmp`. */
	| "scratch"
	/** The old `agent/octocode.db` (only `all`). */
	| "old-database";

interface PurgeItem {
	kind: PurgeKind;
	/** Absolute path to remove; a link is removed as a link and never followed. */
	path: string;
	/** The folder it must stay strictly inside. */
	root: string;
	bytes: number;
}

/** A live process that holds a session or team seat in scope: the purge is refused while one exists. */
interface PurgeBlocker {
	what: string;
	pid: number;
}

export interface PurgePlan {
	scope: PurgeScope;
	/** The workspaces whose data goes (the current one for `workspace`, every registered one for `all`). */
	workspaces: { id: string; root: string }[];
	items: PurgeItem[];
	blockers: PurgeBlocker[];
	/** The current session: its transcript, session folders and team seat stay, so it can continue. */
	current?: string;
	skipped: { path: string; reason: string }[];
}

export interface PlanOptions {
	cwd: string;
	current?: string;
	env?: NodeJS.ProcessEnv;
}

/** The entries of a real directory (a link to one is not entered); none when it is missing. Never follows links. */
async function entriesOf(dir: string): Promise<string[]> {
	if (!(await realDirectory(dir))) return [];
	return (await fs.promises.readdir(dir).catch((): string[] => [])).map((name) => path.join(dir, name));
}

const folderOf = (id: string | undefined): string | undefined => {
	try {
		return id ? sessionDirName(id) : undefined;
	} catch {
		return undefined;
	}
};

/** The JSONL files directly in `dir` (links are not files here), with their session ids; a file without a readable header is kept. */
async function transcriptsIn(dir: string): Promise<{ file: string; id: string; cwd: string | undefined }[]> {
	const found: { file: string; id: string; cwd: string | undefined }[] = [];
	for (const file of await entriesOf(dir)) {
		if (!file.endsWith(".jsonl")) continue;
		const stat = await fs.promises.lstat(file).catch(() => undefined);
		const header = stat?.isFile() ? readSessionHeaderForDiscovery(file) : null;
		if (header) found.push({ file, id: header.id, cwd: getSessionHeaderCwd(header) });
	}
	return found;
}

/** Live holders of sessions in scope: a session row naming a running process, a live team seat (children included). */
function liveBlockers(
	index: SessionIndex,
	ids: ReadonlySet<string> | undefined,
	current: string | undefined,
): PurgeBlocker[] {
	const blockers: PurgeBlocker[] = [];
	for (const row of index.all()) {
		const inScope = ids === undefined || (row.workspace_id !== null && ids.has(row.workspace_id));
		if (inScope && row.id !== current && row.pid !== process.pid && running(row))
			blockers.push({ what: `session ${row.id}`, pid: row.pid as number });
	}
	const seats =
		ids === undefined
			? agents.allProcesses(index.agent.db).map((seat) => ({ ...seat, id: seat.id }))
			: [...ids].flatMap((id) =>
					agents.inWorkspace(index.agent.db, id).map((row) => ({
						id: String(row.id),
						pid: Number(row.pid),
						started: typeof row.started === "string" ? row.started : undefined,
					})),
				);
	for (const seat of seats)
		if (seat.pid !== process.pid && sameProcess(seat.pid, seat.started))
			blockers.push({ what: `team agent ${seat.id}`, pid: seat.pid });
	return blockers;
}

/**
 * Decides what `/purge` removes, without removing anything. `workspace`: the current workspace's transcripts (and the
 * legacy per-folder transcripts of sessions that ran inside it), `.octocode/code/{session-data,temp}` and
 * `<root>/.octocode/tmp`. `all`: the same for every registered workspace whose root still exists, the global
 * `agent/sessions`, every legacy transcript and the old `agent/octocode.db`. The current session's transcript, folders
 * and team seat are never listed. Nothing else is: settings, `auth.json`, `mcp-auth.json`, `child-credentials/`, MCP
 * configuration, the workspace marker, other `.octocode/<topic>/` folders and every file outside the roots stay.
 */
export async function planPurge(index: SessionIndex, scope: PurgeScope, options: PlanOptions): Promise<PurgePlan> {
	const env = options.env ?? process.env;
	const { current } = options;
	const currentName = folderOf(current);
	const plan: PurgePlan = {
		scope,
		workspaces: [],
		items: [],
		blockers: [],
		skipped: [],
		...(current ? { current } : {}),
	};
	const roots = new Map<string, string>();
	if (scope === "workspace") {
		const root = workspaceDataRoot(options.cwd);
		const known = workspaces.list(index.agent.db).find((workspace) => canonicalPath(workspace.root) === root);
		roots.set(known?.id ?? "", root);
	} else {
		for (const workspace of workspaces.list(index.agent.db)) roots.set(workspace.id, workspace.root);
	}
	const add = async (kind: PurgeKind, file: string, root: string) => {
		if (!strictlyInside(root, file)) return;
		plan.items.push({ kind, path: file, root, bytes: await pathSize(file) });
	};
	const notCurrent = (file: string) => path.basename(file) !== currentName;

	for (const [id, root] of roots) {
		if (!(await realDirectory(root))) {
			plan.skipped.push({ path: root, reason: "workspace root is missing" });
			continue;
		}
		if (id) plan.workspaces.push({ id, root });
		const state = path.join(root, WORKSPACE_STATE);
		for (const { file, id: session } of await transcriptsIn(path.join(state, "sessions")))
			if (session !== current) await add("transcript", file, path.join(state, "sessions"));
		for (const entry of await entriesOf(path.join(state, "session-data")))
			if (notCurrent(entry)) await add("session-data", entry, path.join(state, "session-data"));
		const temp = path.join(state, "temp");
		for (const entry of await entriesOf(temp)) {
			if (path.basename(entry) !== "sessions") await add("temp", entry, temp);
			else for (const folder of await entriesOf(entry)) if (notCurrent(folder)) await add("temp", folder, entry);
		}
		// Only `.octocode/tmp`: other `.octocode/<topic>/` folders hold durable output.
		const scratch = octocodeTmpDir(root);
		if (await realDirectory(workspaceOctocodeDir(root)))
			for (const entry of await entriesOf(scratch)) await add("scratch", entry, scratch);
	}

	const legacy = getSessionsDir();
	const legacyDirs = [legacy, ...(await entriesOf(legacy))];
	const inWorkspace = (cwd: string | undefined) =>
		scope === "all" || (cwd !== undefined && [...roots.values()].some((root) => isUnderPath(canonicalPath(cwd), root)));
	for (const dir of legacyDirs) {
		if (dir !== legacy && !(await realDirectory(dir))) continue;
		for (const { file, id, cwd } of await transcriptsIn(dir))
			if (id !== current && inWorkspace(cwd)) await add("legacy-transcript", file, legacy);
	}

	if (scope === "all") {
		const agentState = globalPaths(env).agentState;
		const global = path.join(agentState, "sessions");
		for (const entry of await entriesOf(global)) if (notCurrent(entry)) await add("session-data", entry, global);
		// The pre-workspace database, unless `OCTOCODE_AGENT_DB` makes it the live one: removing it would unlink the open database.
		const old = path.join(agentState, "octocode.db");
		if (canonicalPath(old) !== canonicalPath(agentDbPath(env)))
			for (const suffix of ["", "-wal", "-shm"]) {
				const file = `${old}${suffix}`;
				if (fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) await add("old-database", file, agentState);
			}
	}

	const ids = scope === "all" ? undefined : new Set(plan.workspaces.map((workspace) => workspace.id));
	plan.blockers = liveBlockers(index, ids, current);
	return plan;
}
