import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { workspaces } from "../../../../db/src/api.ts";
import { WORKSPACE_STATE, readWorkspaceIdentity } from "../../config/workspace.ts";
import { deleteSessionFile } from "../../core/session-manager/delete-file.ts";
import { globalPaths, sessionDirName } from "../shared/home.ts";
import type { SessionIndex } from "./store.ts";
import { strictlyInside } from "./sweep-fs.ts";
import { running } from "./sweep-listing.ts";

/** The one way Octocode removes a session: the sweep's transcript expiry and the delete commands share it. */

export interface RemovalTarget {
	id: string;
	/** The transcript (JSONL) to delete. */
	file?: string;
	/** The session's working directory, to find its workspace when its database row does not say. */
	cwd?: string;
}

export interface RemovalResult {
	/** Ids whose transcript, folders and database rows are all gone. */
	removed: string[];
	refused: { id: string; reason: "current" | "running" }[];
	failed: { id: string; path: string; error: string }[];
}

/**
 * The session folders of `target` (`session-data/<id>`, `temp/sessions/<id>`) in the session's own workspace, or the
 * global agent folder for a session without one; each strictly inside its root. Throws when the workspace cannot be
 * verified against its on-disk marker or the id is not a valid folder name.
 */
function sessionFolders(index: SessionIndex, target: RemovalTarget, env: NodeJS.ProcessEnv): string[] {
	const name = sessionDirName(target.id);
	const workspaceId = index.get(target.id)?.workspace_id;
	let root: string | undefined;
	if (workspaceId) {
		const workspace = workspaces.byId(index.agent.db, workspaceId);
		const marker = workspace && readWorkspaceIdentity(workspace.root);
		if (!workspace || marker?.id !== workspace.id || marker.binding !== workspace.binding)
			throw new Error("its workspace could not be verified");
		root = workspace.root;
	} else if (target.cwd) {
		const marker = readWorkspaceIdentity(target.cwd);
		const workspace = marker && workspaces.byId(index.agent.db, marker.id);
		if (workspace && workspace.binding === marker.binding) root = workspace.root;
	}
	const roots = root
		? [path.join(root, WORKSPACE_STATE, "session-data"), path.join(root, WORKSPACE_STATE, "temp", "sessions")]
		: [path.join(globalPaths(env).agentState, "sessions")];
	return roots.map((folderRoot) => {
		const folder = path.join(folderRoot, name);
		if (!strictlyInside(folderRoot, folder)) throw new Error(`folder ${folder} is outside ${folderRoot}`);
		return folder;
	});
}

/**
 * The files beside a transcript that hold its content: saved checkpoints (`<file>.checkpoint-<id>.md`) and backups taken
 * before a migration or repair (`<file>.bak`, `<file>.<n>.bak`). A backup is a whole transcript, and retention only ever
 * sees `.jsonl` files, so these go when their session goes or nothing ever removes them.
 */
async function transcriptSiblings(file: string): Promise<string[]> {
	const base = path.basename(file);
	const names = await fs.promises.readdir(path.dirname(file)).catch(() => [] as string[]);
	return names
		.filter((name) => name.startsWith(`${base}.checkpoint-`) || (name.startsWith(`${base}.`) && name.endsWith(".bak")))
		.map((name) => path.join(path.dirname(file), name));
}

/**
 * Removes sessions: the transcript (to the trash with `trash`, else unlinked) and the files saved beside it, the session-data and temp folders of the
 * session's own workspace, then the database rows of every session removed, with one `erase` (the user deleted them, so the transcript mirror goes too). The current session
 * and any session whose row names a running process are refused. A bad target (unverifiable workspace, a file that
 * cannot be deleted) lands in `failed` with nothing removed for it; the others go on. Never throws.
 */
export async function removeSessions(
	index: SessionIndex,
	targets: readonly RemovalTarget[],
	options: { current?: string; trash?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<RemovalResult> {
	const env = options.env ?? process.env;
	const result: RemovalResult = { removed: [], refused: [], failed: [] };
	for (const target of targets) {
		if (target.id === options.current) {
			result.refused.push({ id: target.id, reason: "current" });
			continue;
		}
		if (running(index.get(target.id))) {
			result.refused.push({ id: target.id, reason: "running" });
			continue;
		}
		let step = target.id;
		try {
			const folders = sessionFolders(index, target, env);
			for (const folder of folders) {
				step = folder;
				await fs.promises.rm(folder, { recursive: true, force: true });
			}
			if (target.file) {
				step = target.file;
				if (options.trash) {
					const deleted = await deleteSessionFile(target.file);
					if (!deleted.ok) throw new Error(deleted.error ?? "could not delete the session file");
				} else await fs.promises.rm(target.file, { force: true });
				for (const sibling of await transcriptSiblings(target.file)) {
					step = sibling;
					await fs.promises.rm(sibling, { force: true });
				}
			}
			result.removed.push(target.id);
		} catch (error) {
			result.failed.push({ id: target.id, path: step, error: errorMessage(error) });
		}
	}
	if (result.removed.length > 0) {
		try {
			index.erase(result.removed);
		} catch (error) {
			for (const id of result.removed) result.failed.push({ id, path: "agent database", error: errorMessage(error) });
			result.removed = [];
		}
	}
	return result;
}
