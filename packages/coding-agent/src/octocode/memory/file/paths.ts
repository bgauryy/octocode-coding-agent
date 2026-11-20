import fs from "node:fs";
import path from "node:path";
import type { MemoryFileRef } from "../../permission/memory-files.ts";
import { gitSync } from "../../../utils/git-command.ts";
import { workspaceGit } from "../../../utils/git-repository.ts";

/**
 * Where each curated memory file lives is in `permission/memory-files.ts`, beside the refusal that keeps the file tool
 * and the shell from changing it around the `memory` tool. This module creates the folder and asks git about the file.
 */

/**
 * Creates the file's folder; a workspace folder also gets `.gitignore` containing `*` the first time, never replaced,
 * so the file stays out of commits by default.
 */
export function ensureMemoryDir(file: MemoryFileRef): void {
	const dir = path.dirname(file.path);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (file.scope !== "workspace") return;
	try {
		fs.writeFileSync(path.join(dir, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

/** Whether git tracks the workspace file: then it is repository content, labeled and never written by Octocode. */
export function trackedByGit(file: MemoryFileRef): boolean {
	if (file.scope !== "workspace" || !workspaceGit(file.root)) return false;
	try {
		gitSync(file.root, ["ls-files", "--error-unmatch", "--", path.relative(file.root, file.path)], { timeoutMs: 2000 });
		return true;
	} catch (error) {
		// `ls-files --error-unmatch` exits 1 for an untracked path; a timeout or a missing git is a real failure.
		if ((error as { status?: number }).status === 1) return false;
		throw error;
	}
}
