import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import path from "node:path";
import { WORKSPACE_STATE } from "../../config/workspace.ts";
import { redactSecrets } from "../../../../common/src/sanitize.ts";

const execFileAsync = promisify(execFile);

/** Config that keeps the repository's hooks from running in a git command Octocode starts on its own. */
export const NO_HOOKS: readonly string[] = ["-c", "core.hooksPath=/dev/null"];

// Project operations must exclude private runtime files even if the repository overrides ignore rules.
const stateGlob = `**/${WORKSPACE_STATE.split(path.sep).join("/")}/**`;
export const WORKSPACE_STATE_PATHSPEC = `:(top,glob,icase)${stateGlob}`;
export const EXCLUDE_WORKSPACE_STATE = `:(top,glob,icase,exclude)${stateGlob}`;

/** Refuse to check out or automatically commit a staged or tracked workspace marker or transcript. */
export async function rejectTrackedWorkspaceState(cwd: string, tree: string): Promise<void> {
	if (await git(cwd, ["ls-files", "--cached", `--with-tree=${tree}`, "--", WORKSPACE_STATE_PATHSPEC]))
		throw new Error(
			"Git tracks private workspace state under .octa/code. Remove it from the index and commit before using worktrees.",
		);
}

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export interface GitOptions {
	/** Variables added to the process environment (e.g. `GIT_INDEX_FILE`, `GIT_OPTIONAL_LOCKS`). */
	env?: NodeJS.ProcessEnv;
	/** Return stdout as git wrote it instead of without trailing whitespace. */
	raw?: boolean;
	timeoutMs?: number;
	/** Kills git when it aborts; the call then rejects with a `GitError`. */
	signal?: AbortSignal;
	/** Output cap in bytes (default 16 MB); beyond it the call rejects with a `GitError` whose `overflow` is true. */
	maxBuffer?: number;
}

/**
 * Why a git call failed. `message` is git's stderr, or the spawn error when git wrote none, with credentials redacted:
 * git repeats a URL as given in some messages (a failed submodule clone), and the spawn error repeats the command line,
 * and callers show the message to the model and the user. The fields let a caller
 * map the failure itself: a timeout (`timedOut`), a plain non-zero exit (`exitCode`, e.g. 1 for "no match"), or output
 * past `maxBuffer` (`overflow`, with the `stdout` that fit).
 */
export class GitError extends Error {
	readonly timedOut: boolean;
	readonly exitCode: unknown;
	readonly overflow: boolean;
	readonly stdout: string;
	constructor(message: string, cause: unknown) {
		super(message);
		const failure = cause as { killed?: unknown; code?: unknown; stdout?: unknown };
		this.name = "GitError";
		this.timedOut = failure.killed === true;
		this.exitCode = failure.code;
		this.overflow = failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
		this.stdout = typeof failure.stdout === "string" ? failure.stdout : "";
	}
}

/**
 * Runs `git args` in `cwd` with no terminal prompt (`GIT_TERMINAL_PROMPT=0`) and a 16 MB output buffer. Resolves to
 * stdout without trailing whitespace; rejects with a `GitError`.
 */
export async function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", [...args], {
			cwd,
			maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
			env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0" },
			...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
			...(options.signal ? { signal: options.signal } : {}),
			windowsHide: true,
		});
		return options.raw ? stdout : stdout.trimEnd();
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new GitError(redactSecrets(stderr || errorMessage(error)), error);
	}
}

/** `git` that resolves to undefined instead of rejecting: for probes whose failure is an answer. */
export const gitQuiet = (cwd: string, args: readonly string[], options?: GitOptions): Promise<string | undefined> =>
	git(cwd, args, options).catch(() => undefined);

export { gitSync } from "../../utils/git-command.ts";
