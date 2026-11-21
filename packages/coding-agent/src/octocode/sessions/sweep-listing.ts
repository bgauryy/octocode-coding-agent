import fs from "node:fs";
import path from "node:path";
import { AGENT_DIR, AGENT_FOLDERS } from "../../storage/agent-layout.ts";
import { listSessionHeaders } from "../../core/session-manager/header-listing.ts";
import { readSessionHeaderForDiscovery } from "../../core/session-manager/storage.ts";
import { type Db, type SessionExtra, workspaces } from "../../../../db/src/api.ts";
import { runningPid } from "../shared/session-liveness.ts";
import { globalPaths, agentTmpDir, sessionDirName } from "../shared/home.ts";
import { realDirectory } from "./sweep-fs.ts";
import type { SweepSkip } from "./sweep-types.ts";

/** What the sweep knows about a session: which of them Octocode lists, which are running, and every root to sweep. */

/**
 * Ids of every session Octocode has a file for, in each session dir a session ran from. Octocode lists an
 * unreadable dir as empty, so each dir is read first: one that turned unreadable since the sweep checked it rejects, and
 * the sweep then removes nothing.
 */
export async function sessionIds(dirs: readonly string[]): Promise<Set<string>> {
	// Ids only: each file's header, never its transcript (a full listing parses every session and keeps its text).
	const lists = await Promise.all(
		dirs.map(async (dir) => {
			await fs.promises.readdir(dir);
			return listSessionHeaders(undefined, dir);
		}),
	);
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

/** One place cleanup looks: a workspace's `.octocode/agent` or the global agent folder. */
export interface SweepScope {
	label: string;
	workspaceId?: string;
	/** Session data roots (`session-data`, `temp/sessions`). */
	durable?: string;
	temp?: string;
	/** Where a session's folders live when its transcript expires from this scope. */
	folderRoots: string[];
	/** Directories holding session JSONL. */
	transcripts: string[];
	/** The workspace scratch folder (`agentTmpDir`), when it and its parent are real directories. */
	scratch?: string;
}

/**
 * Every root a pass looks at: each registered workspace whose root still exists, and the global agent sessions root. A workspace that is gone is listed as skipped, never removed.
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
		const state = path.join(workspace.root, AGENT_DIR);
		const durable = path.join(state, AGENT_FOLDERS.sessionData);
		const temp = path.join(state, AGENT_FOLDERS.temp, "sessions");
		const scratch = agentTmpDir(workspace.root);
		scopes.push({
			label: workspace.root,
			workspaceId: workspace.id,
			durable,
			temp,
			folderRoots: [durable, temp],
			transcripts: [path.join(state, AGENT_FOLDERS.sessions)],
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
