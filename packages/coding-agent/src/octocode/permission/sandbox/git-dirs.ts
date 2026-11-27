import fs from "node:fs";
import path from "node:path";

/** The git folders of a linked worktree (`git worktree add`): its own folder and the repository's shared one. */
export interface LinkedWorktree {
	/** `<common>/worktrees/<name>`: the worktree's `HEAD`, index, reflog and lock files. */
	gitDir: string;
	/** The main repository's git folder: objects, refs, hooks and config every worktree shares. */
	commonDir: string;
	/** The branch the worktree has checked out (`refs/heads/<name>`), or undefined when its `HEAD` is detached. */
	branchRef?: string;
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (error) {
		// Absent or a folder: `root` is not a linked worktree, or its git folder lacks the file.
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EISDIR")
			return undefined;
		throw error;
	}
}

const real = (file: string): string => {
	try {
		return fs.realpathSync(file);
	} catch {
		// A path that does not exist keeps its own spelling.
		return file;
	}
};

/**
 * The git folders of the worktree checked out at `root`, read from its `.git` file (`gitdir: …`) and the `commondir`
 * file git writes beside it; undefined when `root` is an ordinary checkout (its `.git` is a folder) or no checkout.
 */
export function linkedWorktree(root: string): LinkedWorktree | undefined {
	const pointer = readText(path.join(root, ".git"))
		?.match(/^gitdir:\s*(.+)$/m)?.[1]
		?.trim();
	if (!pointer) return undefined;
	const gitDir = real(path.resolve(root, pointer));
	const common = readText(path.join(gitDir, "commondir"))?.trim();
	if (!common) return undefined;
	const branchRef = readText(path.join(gitDir, "HEAD"))
		?.match(/^ref:\s*(refs\/heads\/\S+)\s*$/m)?.[1]
		?.trim();
	return { gitDir, commonDir: real(path.resolve(gitDir, common)), branchRef };
}
