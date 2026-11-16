import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkspaceGit } from "../../../db/src/api.ts";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { isUnderPath } from "@octocodeai/octocode-common/paths";
import { gitSync } from "./git-command.ts";
import { gitMarkerDir } from "./git-marker.ts";

interface RepoKey {
	/** The common Git directory, or the folder itself without a verified repository. */
	key: string;
	root: string;
	name: string;
}

interface Discovery {
	marker: string | undefined;
	revision: string;
	home: string;
	repo: RepoKey;
	git: WorkspaceGit | null | undefined;
	expiresAt: number;
	/** Git lookups in a row that failed for this start directory and marker: each failure doubles the wait. */
	failures: number;
}

const cache = new Map<string, Discovery>();
/** Most start directories remembered (worktrees, subagent folders); the oldest is discovered again when asked. */
const CACHE_MAX = 256;
/**
 * How long a failed Git lookup is remembered: 1 s, doubling per failure in a row, at most a minute. Callers sit on
 * synchronous paths (every session append, permission checks), so a Git that fails or runs into its 2 s timeout must
 * not run again on each of them. A changed marker (the checkout repaired or replaced) is looked up at once.
 */
const FAILED_LOOKUP_MS = 1000;
const FAILED_LOOKUP_MAX_MS = 60_000;

/** A linked checkout's pointer can be rewritten; a normal .git directory also changes mtime on ordinary commits. */
function revision(marker: string | undefined): string {
	if (!marker) return "";
	const info = fs.statSync(path.join(marker, ".git"), { bigint: true, throwIfNoEntry: false });
	return info ? `${info.dev}:${info.ino}:${info.birthtimeNs}:${info.isFile() ? info.ctimeNs : ""}` : "";
}

function spansHome(root: string, home: string): boolean {
	return path.dirname(root) === root || isUnderPath(home, root);
}

/** The paths Git resolved, including the checkout-specific administrative directory of a linked worktree. */
function checkoutPaths(cwd: string): string[] {
	const fields = ["--git-common-dir", "--absolute-git-dir", "--show-toplevel"];
	const query = (flags: string[]) =>
		gitSync(cwd, ["rev-parse", "--path-format=absolute", ...flags], { timeoutMs: 2000 }).replace(/\r?\n$/, "");
	const paths = query(fields).split(/\r?\n/);
	// rev-parse has no NUL separator. A checkout whose name contains a newline needs the fields separately.
	return (paths.length === fields.length ? paths : fields.map((field) => query([field]))).map((file) =>
		canonicalPath(file),
	);
}

function discover(cwd: string): Discovery {
	const start = canonicalPath(cwd);
	const marker = gitMarkerDir(start);
	const home = canonicalPath(os.homedir());
	const stamp = revision(marker);
	const cached = cache.get(start);
	if (
		cached &&
		cached.marker === marker &&
		cached.revision === stamp &&
		cached.home === home &&
		cached.expiresAt > Date.now()
	)
		return cached;

	let root = marker ?? start;
	let key = root;
	let git: Discovery["git"] = null;
	if (marker && !spansHome(marker, home)) {
		try {
			const [common, admin, top] = checkoutPaths(start);
			if (top !== marker) throw new Error("Git resolved a different checkout");
			root = top;
			key = common;
			git = { commonDir: common, linkedWorktree: common !== admin };
		} catch {
			// Keep existing catalog metadata through a temporarily unavailable or unreadable checkout.
			git = undefined;
		}
	}
	if (spansHome(root, home)) {
		root = start;
		key = start;
		git = null;
	}
	const failures =
		git === undefined ? (cached && cached.marker === marker && cached.revision === stamp ? cached.failures : 0) + 1 : 0;
	const result = {
		marker,
		revision: stamp,
		home,
		repo: { key, root, name: path.basename(root) },
		git,
		expiresAt:
			git === undefined
				? Date.now() + Math.min(FAILED_LOOKUP_MAX_MS, FAILED_LOOKUP_MS * 2 ** (failures - 1))
				: Infinity,
		failures,
	};
	cache.delete(start);
	cache.set(start, result);
	if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
	return result;
}

/** Git scope for collaboration and worktree operations. Independent of the durable workspace UUID. */
export const repoKey = (cwd: string): RepoKey => discover(cwd).repo;

/** No checkout is null; an existing marker that Git cannot resolve is unknown. Neither requires a repository ID. */
export const workspaceGit = (cwd: string): Discovery["git"] => discover(cwd).git;

/** Checkout permission boundary. A home directory, its ancestor or a filesystem root is never a blanket grant. */
export function workspaceRoot(cwd: string): string | undefined {
	const { repo, home } = discover(cwd);
	return spansHome(repo.root, home) ? undefined : repo.root;
}
