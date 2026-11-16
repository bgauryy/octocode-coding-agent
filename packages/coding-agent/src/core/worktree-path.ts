import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

/** The folder `<repo root>/.octocode` that `octocode/shared/home.ts` names `OCTOCODE_DIR` (`core/` may not import that layer). */
const WORKSPACE_DIR = ".octocode";

/** `<main>/.octocode/worktrees/<name>` (or a folder inside it), read from the path alone: nothing is touched on disk. */
export function octocodeWorktreeAt(folder: string): { main: string; name: string } | undefined {
	const parts = folder.split(/[\\/]+/u);
	for (let i = parts.length - 2; i >= 1; i--) {
		if (parts[i] !== "worktrees" || parts[i - 1] !== WORKSPACE_DIR || !parts[i + 1]) continue;
		return { main: parts.slice(0, i - 1).join(path.sep) || path.sep, name: parts[i + 1] };
	}
	return undefined;
}

/**
 * Where a session's folder sits, for a picker row: `main` for a repository's main checkout, `worktree <name>` for a linked
 * worktree, undefined for anything else (a plain folder, a subfolder, a submodule). A worktree made by Octocode is told by
 * its path (so one already removed still is); any other by the `.git` file git leaves in a linked worktree. One lstat, plus
 * one small read for a `.git` file, and no git process.
 */
export function checkoutLabel(folder: string): string | undefined {
	const octocodeWorktree = octocodeWorktreeAt(folder);
	if (octocodeWorktree) return `worktree ${octocodeWorktree.name}`;
	try {
		const dotGit = path.join(folder, ".git");
		if (lstatSync(dotGit).isDirectory()) return "main";
		// `gitdir: <common dir>/worktrees/<id>` for a linked worktree, `.../modules/<name>` for a submodule.
		const pointer = readFileSync(dotGit, "utf8").slice(0, 4096);
		return /^gitdir:.*[\\/]worktrees[\\/][^\\/\n]+\s*$/mu.test(pointer)
			? `worktree ${path.basename(folder)}`
			: undefined;
	} catch {
		return undefined;
	}
}

/** What to do about a session folder that is gone, when it was an Octocode worktree; undefined for any other folder. */
export function worktreeRecoveryHint(missingFolder: string): string | undefined {
	const worktree = octocodeWorktreeAt(missingFolder);
	if (!worktree) return undefined;
	return `This was worktree ${worktree.name}: recreate it with /worktree new ${worktree.name} (or octocode --worktree ${worktree.name}) from a checkout of the same repository, then resume the session.`;
}

/** `checkoutLabel` of a session folder, with `(gone)` after the label of a worktree whose folder no longer exists. */
export function checkoutText(folder: string): string | undefined {
	const label = checkoutLabel(folder);
	return label?.startsWith("worktree ") && !existsSync(folder) ? `${label} (gone)` : label;
}
