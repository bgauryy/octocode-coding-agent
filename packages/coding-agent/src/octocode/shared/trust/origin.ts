import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../../../../../common/src/atomic-file.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { globalPaths } from "../home.ts";
import { parseJson } from "../util.ts";
import { readText, realPath } from "./files.ts";
import { withFileLock } from "./store.ts";

/**
 * Trust for the worktrees Octocode creates (`octocode --worktree`, `/worktree new`). Octocode records each one in
 * `<Octocode home>/worktree-origins.json`, beside the trust store, keyed by the worktree's resolved root with the git
 * common dir it belongs to. The record lives outside the worktree, so no branch, file or hook can claim it; a worktree
 * added with plain `git worktree add` has none and is asked about like any other folder.
 */

interface WorktreeOrigin {
	commonDir: string;
	main: string;
}

const originsPath = (home?: string) => path.join(globalPaths(process.env, home).home, "worktree-origins.json");

function readOrigins(home?: string): Record<string, WorktreeOrigin> {
	const parsed = parseJson(readText(originsPath(home)));
	if (!isRecord(parsed)) return {};
	return Object.fromEntries(
		Object.entries(parsed).flatMap(([key, value]) =>
			isRecord(value) && typeof value.commonDir === "string" && typeof value.main === "string"
				? [[key, { commonDir: value.commonDir, main: value.main }]]
				: [],
		),
	);
}

/**
 * The git common dir of the linked worktree at `root`: its `.git` file points into `<common dir>/worktrees/<id>`. Git never
 * tracks a `.git` file, so a branch cannot supply one. Undefined for a main checkout or anything else.
 */
function worktreeCommonDir(root: string): string | undefined {
	const gitdir = /^gitdir:\s*(.+)$/m.exec(readText(path.join(root, ".git")))?.[1]?.trim();
	if (!gitdir) return undefined;
	const entry = realPath(path.resolve(root, gitdir));
	const folder = path.dirname(entry);
	return path.basename(folder) === "worktrees" ? path.dirname(folder) : undefined;
}

/** Records that Octocode created the worktree at `root` from the main checkout `main`. Best effort: without a record the worktree is asked about. */
export function recordWorktreeOrigin(root: string, main: string, home?: string): void {
	try {
		const common = worktreeCommonDir(root);
		if (!common) return;
		const file = originsPath(home);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		withFileLock(file, () => {
			const origins = readOrigins(home);
			origins[realPath(root)] = { commonDir: common, main: realPath(main) };
			atomicWriteFileSync(file, `${JSON.stringify(origins, null, 2)}\n`, { mode: 0o600 });
		});
	} catch {
		// The home folder is not writable (or the lock is stuck): no record, so trust asks as it does for any worktree.
	}
}

/**
 * The main checkout Octocode created the worktree at `root` from, when the record is still true: the worktree is still
 * linked to the recorded common dir, and that dir belongs to the recorded main checkout. Otherwise undefined.
 */
export function createdFrom(root: string, home?: string): string | undefined {
	const common = worktreeCommonDir(root);
	if (!common) return undefined;
	const origin = readOrigins(home)[realPath(root)];
	if (!origin || origin.commonDir !== common || realPath(path.join(origin.main, ".git")) !== common) return undefined;
	return origin.main;
}
