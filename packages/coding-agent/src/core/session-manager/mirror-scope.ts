import os from "node:os";
import path from "node:path";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { isUnderPath } from "@octocodeai/octocode-common/paths";
import { getAgentDir } from "../../config.ts";
import { AGENT_DIR, AGENT_FOLDERS } from "../../storage/agent-layout.ts";
import { workspaceStateDir } from "../../storage/workspace.ts";
import type { SessionState } from "./state.ts";

/**
 * Which session files the database mirror indexes. A file in a temporary folder (the system's, or a repository's
 * `.octocode/agent/tmp/` scratch folder) belongs to a test, a benchmark or a copy, so it stays out of the transcripts
 * database that session search, `/resume` by id and usage profiles read. An active session folder is indexed wherever
 * it is: the session directory a caller chose (`--session-dir`, not merely the folder of a file opened by path), the
 * workspace's own state folder (its sessions and its subagents' sessions) and the Octocode home.
 */
export function mirrorsSessionFile(
	file: string,
	state: Pick<SessionState, "cwd" | "sessionDir" | "sessionDirFromFile">,
): boolean {
	if (!isScratch(file)) return true;
	const chosen = state.sessionDir && !state.sessionDirFromFile ? [state.sessionDir] : [];
	const active = [...chosen, workspaceStateDir(state.cwd), getAgentDir()].map((dir) => canonicalPath(dir));
	return active.some((dir) => isUnderPath(file, dir));
}

const [OCTOCODE_FOLDER, AGENT_FOLDER] = AGENT_DIR.split(path.sep);

/** `file` (canonical) is in a temporary folder or a `.octocode/agent/tmp/` scratch folder. */
function isScratch(file: string): boolean {
	if (
		file
			.split(path.sep)
			.some(
				(part, at, parts) =>
					part === OCTOCODE_FOLDER && parts[at + 1] === AGENT_FOLDER && parts[at + 2] === AGENT_FOLDERS.tmp,
			)
	)
		return true;
	return temporaryRoots().some((root) => isUnderPath(file, root));
}

let roots: { tmpdir: string; roots: string[] } | undefined;

/** The system's temporary folders, canonical; the current `os.tmpdir()` (a test run moves it) is among them. */
function temporaryRoots(): string[] {
	const tmpdir = os.tmpdir();
	if (roots?.tmpdir === tmpdir) return roots.roots;
	const candidates = [tmpdir, "/tmp", "/var/tmp", ...(process.platform === "darwin" ? ["/var/folders"] : [])];
	const resolved = process.platform === "win32" ? [path.resolve(tmpdir)] : candidates.map((dir) => path.resolve(dir));
	roots = { tmpdir, roots: [...new Set([...resolved, ...resolved.map((dir) => canonicalPath(dir))])] };
	return roots.roots;
}
