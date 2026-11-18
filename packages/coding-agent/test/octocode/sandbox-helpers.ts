import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmp } from "./helpers.ts";

/** The session's environment without any subagent role, whatever the process running the tests is. */
export function mainEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of ["OCTOCODE_SUBAGENT", "OCTOCODE_READ_ONLY", "OCTOCODE_TEAM_WORKSPACE", "OCTOCODE_AGENT_SCRATCH"])
		delete env[name];
	return { ...env, ...extra };
}

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

/**
 * A repository with one commit and a linked worktree on its own branch, as an isolated child gets, each in a new folder
 * `folder` makes (the system temporary folder by default, which the sandbox leaves writable).
 */
export function repoWithWorktree(folder: () => string = tmp): { main: string; worktree: string } {
	const main = fs.realpathSync(folder());
	git(main, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(main, "a.txt"), "a");
	git(main, "add", ".");
	git(main, "commit", "-qm", "one");
	const worktree = path.join(fs.realpathSync(folder()), "child");
	git(main, "worktree", "add", "-q", "-b", "agent/child", worktree);
	return { main, worktree };
}
