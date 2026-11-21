import path from "node:path";
import { CONTEXT_FILE_CANDIDATES } from "../../../core/discovery/sources.ts";
import { AGENT_DIR, AGENT_FOLDERS, MEMORY_FILE, OCTOCODE_DIR } from "../../../storage/agent-layout.ts";
import { RUNS_LATER_ANYWHERE, RUNS_LATER_AT_ROOT } from "../file-access.ts";
import { LOADED_BY_LATER_SESSIONS } from "../later-session-loaded.ts";

/** Entries of `.octocode/agent/` that are not data, as sandbox paths relative to it: Octocode's state, `MEMORY.md` (the `memory` tool's) and the event view with its lock files. */
const AGENT_PROTECTED = [
	AGENT_FOLDERS.marker,
	AGENT_FOLDERS.sessions,
	AGENT_FOLDERS.sessionData,
	"agents.txt*",
	"backlog.md",
	"backlog.html",
	MEMORY_FILE,
];

/** `AGENT_PROTECTED` under the workspace at `prefix`, and optionally its `worktrees/` folder, whether or not they exist yet. */
const agentProtected = (prefix: string, worktrees: boolean): string[] =>
	[...AGENT_PROTECTED, ...(worktrees ? [AGENT_FOLDERS.worktrees] : [])].map((name) =>
		path.join(prefix, AGENT_DIR, name),
	);

/** Paths under one checkout that load code, hooks or instructions in a later session, mirroring `runsLater`. */
function checkoutPaths(prefix: string): string[] {
	const octocode = path.join(prefix, OCTOCODE_DIR);
	return [
		// The repository's own `.git` stays writable for commits; its hooks and config are what run later.
		...RUNS_LATER_AT_ROOT.filter((entry) => entry !== ".git").map((entry) => path.join(prefix, entry)),
		...RUNS_LATER_ANYWHERE.map((entry) => path.join(prefix, entry)),
		...CONTEXT_FILE_CANDIDATES.map((name) => path.join(prefix, name)),
		...[...LOADED_BY_LATER_SESSIONS].map((entry) => path.join(octocode, entry)),
		...agentProtected(prefix, false),
	];
}

/**
 * What a sandboxed command may not change inside the writable checkout `root`, whether or not the path exists yet: the
 * folders and files `runsLater` names at the root (other harnesses' project folders, `.octocode/` configuration, the
 * instruction files), git hooks and config at any depth (a nested repository's too), Octocode's state and `MEMORY.md`
 * in `.octocode/agent/`, and the same list inside each checkout under `.octocode/agent/worktrees/`. A write there would run or steer a later
 * session, which outlives the command. Packages a command installs keep their own files: the any-depth patterns other
 * than git's are applied at the root only, since `node_modules` holds `.npmrc`, `.github` and instruction files.
 */
export function protectedPaths(root: string): string[] {
	return [
		...checkoutPaths(root),
		path.join(root, "**", ".git", "hooks"),
		path.join(root, "**", ".git", "config"),
		...checkoutPaths(path.join(root, AGENT_DIR, AGENT_FOLDERS.worktrees, "*")),
	];
}

/**
 * Inside `.octocode/` of the workspace at `root`, what a read-only child's Markdown and scratch carve-outs must still
 * not reach: every entry later sessions load, `.octocode/agent/`'s state, `MEMORY.md` and checkouts under `worktrees/`, and
 * `temp/sessions/`.
 */
export function readOnlyProtectedPaths(root: string): string[] {
	const octocode = path.join(root, OCTOCODE_DIR);
	return [
		...[...LOADED_BY_LATER_SESSIONS].map((entry) => path.join(octocode, entry)),
		...agentProtected(root, true),
		path.join(root, AGENT_DIR, AGENT_FOLDERS.temp, "sessions"),
	];
}
