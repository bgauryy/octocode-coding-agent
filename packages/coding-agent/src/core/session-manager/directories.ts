import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { workspaces } from "../../../../db/src/api.ts";
import { resolvePath } from "../../../../common/src/paths.ts";
import { getSessionsDir } from "../../config.ts";
import { sharedAgentDb } from "../../config/database.ts";
import { isCurrentWorkspace, workspaceStateDir } from "../../config/workspace.ts";

/** Default transcript directories. Pre-workspace JSONL directories remain discoverable for import. */
export async function knownSessionDirectories(): Promise<string[]> {
	const legacy = getSessionsDir();
	const dirs = (await readdir(legacy, { withFileTypes: true }).catch(() => []))
		.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
		.map((entry) => join(legacy, entry.name));
	let registered: ReturnType<typeof workspaces.list>;
	try {
		registered = workspaces.list(sharedAgentDb().db);
	} catch {
		// Existing JSONL files can still be imported when SQLite refuses this configuration.
		return dirs;
	}
	for (const workspace of registered) {
		try {
			// A removed checkout, or another one occupying the same path, has no live files for this ID.
			if (isCurrentWorkspace(workspace)) dirs.push(workspaceStateDir(workspace.root, "sessions"));
		} catch {
			// An unavailable workspace cannot hide accessible ones.
		}
	}
	return [...new Set(dirs)];
}

/** A transcript folder of one cwd; `filterCwd` means its files must have a header cwd equal to that cwd. */
export interface CwdSessionDirectory {
	dir: string;
	filterCwd: boolean;
}

/** The pre-workspace folder of a cwd (`--<cwd with separators as dashes>--`), whether or not it exists. */
export function legacySessionDirectoryPath(cwd: string): string {
	const encoded = resolvePath(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-");
	return join(getSessionsDir(), `--${encoded}--`);
}

/**
 * Where the default session directory of `cwd` keeps transcripts: the workspace folder (shared by the checkout, not
 * filtered) and, when it exists, the legacy folder of exactly this cwd. The encoding is lossy, so legacy files are
 * filtered by header cwd. Creates nothing.
 */
export function defaultSessionDirectories(cwd: string): CwdSessionDirectory[] {
	const workspace = workspaceStateDir(cwd, "sessions");
	const legacy = legacySessionDirectoryPath(cwd);
	const dirs: CwdSessionDirectory[] = [{ dir: workspace, filterCwd: false }];
	if (legacy !== workspace && existsSync(legacy)) dirs.push({ dir: legacy, filterCwd: true });
	return dirs;
}
