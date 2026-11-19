import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_SCRATCH_ENV } from "@octocodeai/octocode-common/env";
import { isUnderPath } from "@octocodeai/octocode-common/paths";
import { getAgentDir } from "../../../config.ts";
import type { SandboxMode } from "../../../core/settings-defaults.ts";
import { WORKSPACE_STATE } from "../../../storage/workspace.ts";
import { workspaceRoot } from "../../../utils/git-repository.ts";
import { OCTOCODE_DIR } from "../../shared/home.ts";
import { isolatedMainTree } from "../isolated-tree.ts";
import type { PermissionMode } from "../mode.ts";
import { readOnlyRole } from "../read-only-role.ts";
import { linkedWorktree } from "./git-dirs.ts";
import { protectedPaths, readOnlyProtectedPaths } from "./protected.ts";

/** What a sandboxed command may change and read: absolute paths (globs where `*` appears), symlinks resolved where the path exists. */
export interface SandboxPolicy {
	allowWrite: string[];
	denyWrite: string[];
	denyRead: string[];
}

/**
 * Which hosts a sandboxed command may reach beyond loopback: `none` for a read-only child, `all` in `full` and `bypass`
 * (each connection recorded; a private address still asks as `net.private` where that asks), else `ask`: a host
 * asks as `net.shell` (`net.private` for a private address) until it is allowed for the session.
 */
type ShellNetwork = "none" | "ask" | "all";

export function shellNetwork(mode: PermissionMode, env: NodeJS.ProcessEnv): ShellNetwork {
	if (readOnlyRole(env)) return "none";
	return mode === "full" || mode === "bypass" ? "all" : "ask";
}

/** The facts a command's policy follows: the `sandbox.mode` setting, the session's permission mode and this process's role. */
export interface SandboxContext {
	setting: SandboxMode;
	mode: PermissionMode;
	env: NodeJS.ProcessEnv;
}

function real(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch {
		// A path that does not exist yet keeps its own spelling.
		return file;
	}
}

/** Folders under the home folder that hold keys and tokens of other programs. */
const CREDENTIAL_FOLDERS = [".ssh", ".aws", ".gnupg"];

/**
 * What no sandboxed command reads: the agent directory's `auth.json` and the home folder's `.ssh`, `.aws` and `.gnupg`.
 * A command that needs one runs outside the sandbox through `shell.unsandboxed`, which asks. Each path is listed as
 * given and with symlinks resolved, so a linked home or agent directory stays covered.
 */
function credentialPaths(): string[] {
	const paths = [
		path.join(getAgentDir(), "auth.json"),
		...CREDENTIAL_FOLDERS.map((name) => path.join(os.homedir(), name)),
	];
	return [...new Set(paths.flatMap((entry) => [entry, real(entry)]))];
}

/**
 * The system temporary folder: the sandboxed shell's own `TMPDIR`. The sandbox library points `TMPDIR` at
 * `CLAUDE_CODE_TMPDIR` (else `/tmp/claude`); naming this folder keeps a command's temporary files where they were
 * without the sandbox. Set once: the value never changes within a process.
 */
export function sandboxTempDir(): string {
	return real(os.tmpdir());
}

/**
 * Folders the sandbox library opens or protects for Claude Code. Octocode has no use for them: the shared `/tmp/claude`
 * and `~/.claude/debug` are write-denied again, so one sandboxed command cannot plant files another tool reads.
 */
function claudeDefaultDenyWrite(): string[] {
	return ["/tmp/claude", "/private/tmp/claude", path.join(os.homedir(), ".claude", "debug")];
}

/**
 * Octocode state a command run by the agent writes on purpose: the host lock that lets one full test run or check at a
 * time (`scripts/full-run-lock.ts`, under the account's home whatever `HOME` says). The rest of the Octocode home stays
 * closed: it holds credentials (`auth.json`), the memory database and configuration later sessions load.
 */
const hostLockDir = (): string => path.join(os.userInfo().homedir, OCTOCODE_DIR, "locks");

/** Writable everywhere: the temporary folders, the agent's scratch folder and the host lock. */
function sharedWrites(env: NodeJS.ProcessEnv): string[] {
	const scratch = env[AGENT_SCRATCH_ENV];
	return [sandboxTempDir(), "/tmp", "/private/tmp", ...(scratch ? [real(scratch)] : []), real(hostLockDir())];
}

/**
 * A read-only child's carve-outs, as `read-only-role.ts` allows them: the workspace's throwaway folders (`.octocode/tmp/`,
 * the state folder's scratch, a topic's `tmp/`) and Markdown docs under `.octocode/` outside what later sessions load.
 */
function readOnlyPolicy(root: string, env: NodeJS.ProcessEnv): SandboxPolicy {
	const octocode = path.join(root, OCTOCODE_DIR);
	return {
		allowWrite: [
			...sharedWrites(env),
			path.join(octocode, "tmp"),
			path.join(root, WORKSPACE_STATE, "temp"),
			path.join(octocode, "*", "tmp"),
			path.join(octocode, "**", "*.md"),
		],
		denyWrite: [...claudeDefaultDenyWrite(), ...readOnlyProtectedPaths(root)],
		denyRead: credentialPaths(),
	};
}

/**
 * What an isolated child may change in the main repository's git folder to commit on its own branch: new objects, its
 * worktree's folder (`HEAD`, index, reflog) and its branch's ref, lock and reflog. The main working tree, the main
 * `HEAD`, other refs, hooks and config stay closed, so `git -C <main> checkout` fails even where the parse misses it.
 */
function isolatedGitWrites(root: string): { allow: string[]; deny: string[] } {
	const worktree = linkedWorktree(root);
	if (!worktree) return { allow: [], deny: [] };
	const { commonDir, gitDir, branchRef } = worktree;
	const branch = branchRef
		? [
				path.join(commonDir, branchRef),
				path.join(commonDir, `${branchRef}.lock`),
				path.join(commonDir, "logs", branchRef),
				path.join(commonDir, "logs", `${branchRef}.lock`),
			]
		: [];
	return {
		allow: [path.join(commonDir, "objects"), gitDir, ...branch],
		// With `extensions.worktreeConfig` git reads this file as config: a `core.hooksPath` there would run later.
		deny: [path.join(gitDir, "config.worktree")],
	};
}

/** A linked worktree's shared git folder, writable as a checkout's own `.git` is, its hooks and config protected. */
function sharedGitWrites(root: string): { allow: string[]; deny: string[] } {
	const worktree = linkedWorktree(root);
	if (!worktree) return { allow: [], deny: [] };
	const { commonDir, gitDir } = worktree;
	return {
		allow: [commonDir],
		deny: [path.join(commonDir, "hooks"), path.join(commonDir, "config"), path.join(gitDir, "config.worktree")],
	};
}

/**
 * The policy of a command started in `cwd`, or undefined when it runs unsandboxed: `sandbox.mode` is `"off"`, or `"auto"`
 * in `bypass` mode. Every sandboxed command reads everything but `credentialPaths` and writes the temporary folders, its scratch folder and
 * the host lock; then, narrowest first:
 * - a read-only child writes only its throwaway folders and Markdown under `.octocode/` (`read-only-role.ts`);
 * - an isolated child writes its own worktree and, in the main git folder, only what a commit on its branch needs;
 * - otherwise the workspace (the repository root, else the working folder) and, in a linked worktree, the shared git
 *   folder.
 * Paths that run or load in later sessions stay write-protected in every case (`protectedPaths`). The network goes
 * through the sandbox's proxy, by `shellNetwork`. Throws when `cwd` is the home folder, one of its ancestors or a
 * filesystem root: that would make the whole home writable.
 */
export function sandboxPolicy(cwd: string, { setting, mode, env }: SandboxContext): SandboxPolicy | undefined {
	if (setting === "off" || (setting === "auto" && mode === "bypass")) return undefined;
	const folder = real(path.resolve(cwd));
	const root = workspaceRoot(folder) ?? folder;
	if (path.dirname(root) === root || isUnderPath(real(os.homedir()), root))
		throw new Error(
			`The command sandbox needs a project folder to allow writes in, and ${folder} is your home folder or above it. Start the session in a project folder, or set sandbox.mode to "off".`,
		);
	if (readOnlyRole(env)) return readOnlyPolicy(root, env);
	const git = isolatedMainTree(folder, env) ? isolatedGitWrites(root) : sharedGitWrites(root);
	return {
		allowWrite: [...new Set([root, ...sharedWrites(env), ...git.allow])],
		denyWrite: [...claudeDefaultDenyWrite(), ...protectedPaths(root), ...git.deny],
		denyRead: credentialPaths(),
	};
}
