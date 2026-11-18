import fs from "node:fs";
import path from "node:path";
import { CONTEXT_FILE_CANDIDATES } from "../../../core/discovery/sources.ts";
import { WORKSPACE_STATE } from "../../../storage/workspace.ts";
import { OCTOCODE_DIR } from "../../shared/home.ts";
import { RUNS_LATER_ANYWHERE, RUNS_LATER_AT_ROOT } from "../file-access.ts";
import { LOADED_BY_LATER_SESSIONS } from "../later-session-loaded.ts";

/** Inside the workspace state folder only this one is scratch; every other entry is a transcript, the database or an id. */
const STATE_SCRATCH = "temp";
/** Entries of the workspace state folder protected before they exist; ones a later version adds are listed when present. */
const STATE_ENTRIES = ["sessions", "session-data", "workspace", "agents.txt"];
/** `.octocode/` entries handled apart: the state folder keeps its scratch writable, and each checkout under `worktrees/` is a workspace of its own. */
const SPLIT_ENTRIES = new Set(["code", "worktrees"]);

/**
 * The workspace state folder's protected entries: every entry present but the scratch, and the known ones even before
 * they exist. A sandbox rule denies a folder with everything under it, so the folder itself cannot be denied while its
 * scratch stays writable.
 */
function stateEntries(root: string): string[] {
	const state = path.join(root, WORKSPACE_STATE);
	let present: string[] = [];
	try {
		present = fs.readdirSync(state);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const names = new Set([...STATE_ENTRIES, ...present].filter((name) => name !== STATE_SCRATCH));
	// A Markdown file straight in the state folder: a read-only child may otherwise write `.octocode/**/*.md`.
	return [...[...names].map((name) => path.join(state, name)), path.join(state, "*.md")];
}

/** Paths under one checkout that load code, hooks or instructions in a later session, mirroring `runsLater`. */
function checkoutPaths(prefix: string): string[] {
	const octocode = path.join(prefix, OCTOCODE_DIR);
	return [
		// The repository's own `.git` stays writable for commits; its hooks and config are what run later.
		...RUNS_LATER_AT_ROOT.filter((entry) => entry !== ".git").map((entry) => path.join(prefix, entry)),
		...RUNS_LATER_ANYWHERE.map((entry) => path.join(prefix, entry)),
		...CONTEXT_FILE_CANDIDATES.map((name) => path.join(prefix, name)),
		...[...LOADED_BY_LATER_SESSIONS]
			.filter((entry) => !SPLIT_ENTRIES.has(entry))
			.map((entry) => path.join(octocode, entry)),
	];
}

/**
 * What a sandboxed command may not change inside the writable checkout `root`, whether or not the path exists yet: the
 * folders and files `runsLater` names at the root (other harnesses' project folders, `.octocode/` configuration, the
 * instruction files), git hooks and config at any depth (a nested repository's too), the workspace state but its
 * scratch, and the same list inside each checkout under `.octocode/worktrees/`. A write there would run or steer a later
 * session, which outlives the command. Packages a command installs keep their own files: the any-depth patterns other
 * than git's are applied at the root only, since `node_modules` holds `.npmrc`, `.github` and instruction files.
 */
export function protectedPaths(root: string): string[] {
	return [
		...checkoutPaths(root),
		path.join(root, "**", ".git", "hooks"),
		path.join(root, "**", ".git", "config"),
		...stateEntries(root),
		...checkoutPaths(path.join(root, OCTOCODE_DIR, "worktrees", "*")),
	];
}

/**
 * Inside `.octocode/` of the workspace at `root`, what a read-only child's Markdown and scratch carve-outs must still
 * not reach: every entry later sessions load, checkouts under `worktrees/` included, and the state folder but its scratch.
 */
export function readOnlyProtectedPaths(root: string): string[] {
	const octocode = path.join(root, OCTOCODE_DIR);
	return [
		...[...LOADED_BY_LATER_SESSIONS].filter((entry) => entry !== "code").map((entry) => path.join(octocode, entry)),
		...stateEntries(root),
		path.join(root, WORKSPACE_STATE, STATE_SCRATCH, "sessions"),
	];
}
