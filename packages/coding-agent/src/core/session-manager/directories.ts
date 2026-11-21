import { workspaces } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { AGENT_FOLDERS } from "../../storage/agent-layout.ts";
import { isCurrentWorkspace, workspaceStateDir } from "../../storage/workspace.ts";

/** Every registered workspace's transcript directory that still belongs to its checkout. */
export async function knownSessionDirectories(): Promise<string[]> {
	const dirs: string[] = [];
	let registered: ReturnType<typeof workspaces.list>;
	try {
		registered = workspaces.list(sharedAgentDb().db);
	} catch {
		// SQLite refused this configuration: no workspace is known.
		return dirs;
	}
	for (const workspace of registered) {
		try {
			// A removed checkout, or another one occupying the same path, has no live files for this ID.
			if (isCurrentWorkspace(workspace)) dirs.push(workspaceStateDir(workspace.root, AGENT_FOLDERS.sessions));
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

/** Where the default session directory of `cwd` keeps transcripts: the workspace folder, shared by the checkout. Creates nothing. */
export function defaultSessionDirectories(cwd: string): CwdSessionDirectory[] {
	return [{ dir: workspaceStateDir(cwd, AGENT_FOLDERS.sessions), filterCwd: false }];
}
