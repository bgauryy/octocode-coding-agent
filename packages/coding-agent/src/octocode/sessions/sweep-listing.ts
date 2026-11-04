import fs from "node:fs";
import path from "node:path";
import { getSessionsDir } from "../../config.ts";
import { WORKSPACE_STATE } from "../../config/workspace.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { readSessionHeaderForDiscovery } from "../../core/session-manager/storage.ts";
import { type Db, type SessionExtra, workspaces } from "../../../../db/src/api.ts";
import { runningPid } from "../shared/session-liveness.ts";
import { globalPaths, octocodeTmpDir, sessionDirName } from "../shared/home.ts";
import { realDirectory } from "./sweep-fs.ts";
import type { SweepSkip } from "./sweep-types.ts";

/** What the sweep knows about a session: which of them Octocode lists, which are running, and every root to sweep. */

/**
 * Ids of every session Octocode has a file for: in its default sessions dir and in each custom session dir a session ran from.
 * Octocode lists an unreadable dir as empty, so each dir is read first: a default dir that cannot be read (only a missing
 * one means no sessions yet), or a custom dir that turned unreadable since the sweep checked it, rejects, and the sweep
 * then removes nothing.
 */
export async function sessionIds(dirs: readonly string[]): Promise<Set<string>> {
	const lists = await Promise.all([
		fs.promises.readdir(getSessionsDir()).then(
			() => SessionManager.listAll(),
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return [];
				throw error;
			},
		),
		...dirs.map(async (dir) => {
			await fs.promises.readdir(dir);
			return SessionManager.listAll(dir);
		}),
	]);
	return new Set(lists.flat().map((info) => info.id));
}

/** Recorded session dirs that cannot be read now (unmounted, removed, no permission): their sessions cannot be listed. */
export async function unreadableDirs(dirs: readonly string[]): Promise<Set<string>> {
	const readable = await Promise.all(
		dirs.map((dir) =>
			fs.promises.readdir(dir).then(
				() => true,
				() => false,
			),
		),
	);
	return new Set(dirs.filter((_, at) => !readable[at]));
}

/** Whether the session of `row` is open in a running process (`shared/session-liveness`); false without a row. */
export const running = (row: SessionExtra | undefined) => runningPid(row?.pid, row?.pid_started) !== undefined;

/** A session id's folder name, or none for a malformed id (`sessionDirName` refuses it): one bad row skips, not the sweep. */
export function folderName(id: string): string[] {
	try {
		return [sessionDirName(id)];
	} catch {
		return [];
	}
}

/** One place cleanup looks: a workspace's `.octocode/code`, the global agent folder, or the legacy per-folder transcripts. */
export interface SweepScope {
	label: string;
	workspaceId?: string;
	/** Session data roots (`session-data`, `temp/sessions`); absent for the legacy scope. */
	durable?: string;
	temp?: string;
	/** Where a session's folders live when its transcript expires from this scope. */
	folderRoots: string[];
	/** Directories holding session JSONL. */
	transcripts: string[];
	/** An emptied transcript directory goes too (legacy folders), never a workspace's own `sessions`. */
	prunesEmptyDirs: boolean;
	/** The workspace scratch folder (`octocodeTmpDir`), when it and its parent are real directories. */
	scratch?: string;
}

/**
 * Every root a pass looks at: each registered workspace whose root still exists, the global agent sessions root, and
 * the legacy per-folder transcript directories. A workspace that is gone is listed as skipped, never removed.
 */
export async function sweepScopes(
	db: Db,
	env: NodeJS.ProcessEnv,
): Promise<{ scopes: SweepScope[]; skipped: SweepSkip[] }> {
	const scopes: SweepScope[] = [];
	const skipped: SweepSkip[] = [];
	const seen = new Set<string>();
	for (const workspace of workspaces.list(db)) {
		if (seen.has(workspace.root)) continue;
		seen.add(workspace.root);
		if (!(await realDirectory(workspace.root))) {
			skipped.push({ path: workspace.root, reason: "workspace root is missing" });
			continue;
		}
		const state = path.join(workspace.root, WORKSPACE_STATE);
		const durable = path.join(state, "session-data");
		const temp = path.join(state, "temp", "sessions");
		const scratch = octocodeTmpDir(workspace.root);
		scopes.push({
			label: workspace.root,
			workspaceId: workspace.id,
			durable,
			temp,
			folderRoots: [durable, temp],
			transcripts: [path.join(state, "sessions")],
			prunesEmptyDirs: false,
			...((await realDirectory(path.dirname(scratch))) && (await realDirectory(scratch)) ? { scratch } : {}),
		});
	}
	const global = path.join(globalPaths(env).agentState, "sessions");
	scopes.push({
		label: global,
		durable: global,
		temp: global,
		folderRoots: [global],
		transcripts: [],
		prunesEmptyDirs: false,
	});
	const legacy = getSessionsDir();
	const folders = await fs.promises.readdir(legacy, { withFileTypes: true }).catch((): fs.Dirent[] => []);
	scopes.push({
		label: legacy,
		folderRoots: [global],
		transcripts: [
			legacy,
			...folders.filter((entry) => entry.isDirectory()).map((entry) => path.join(legacy, entry.name)),
		],
		prunesEmptyDirs: true,
	});
	return { scopes, skipped };
}

export interface Transcript {
	file: string;
	id: string;
	mtime: number;
	/** The directory holding it. */
	dir: string;
}

/**
 * The JSONL files of a scope's transcript directories with their session ids (from the header; a file without a readable
 * header is not listed, so it is kept). A directory that is missing has none; one that cannot be read makes the whole
 * scope unreadable (undefined), so none of its sessions is judged. Links are not followed.
 */
export async function scanTranscripts(scope: SweepScope): Promise<{ files: Transcript[]; unreadable?: string }> {
	const files: Transcript[] = [];
	for (const dir of scope.transcripts) {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return { files, unreadable: dir };
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const file = path.join(dir, entry.name);
			const stat = await fs.promises.lstat(file).catch(() => undefined);
			const header = stat?.isFile() ? readSessionHeaderForDiscovery(file) : null;
			if (stat && header) files.push({ file, id: header.id, mtime: stat.mtimeMs, dir });
		}
	}
	return { files };
}
