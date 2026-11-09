import fs from "node:fs";
import path from "node:path";

/** The isolated worktree a subagent runs in, and the main checkout its system prompt names instead. */
export const WORKTREE_ROOT_ENV = "OCTOCODE_WORKTREE_ROOT";
export const PROMPT_ROOT_ENV = "OCTOCODE_PROMPT_ROOT";

export interface PromptRoots {
	/** The worktree root the child really runs in. */
	worktree: string;
	/** The main checkout root its prompt shows in place of the worktree. */
	root: string;
}

const realPath = (dir: string): string => {
	try {
		return fs.realpathSync(dir);
	} catch {
		return dir;
	}
};

/**
 * `file` with the worktree root replaced by the main checkout root; unchanged when it is outside the worktree. A child's
 * own cwd is the resolved path (symlinked temp or home directories), so both spellings of the worktree match.
 */
export function rebasePath(file: string, { worktree, root }: PromptRoots): string {
	for (const from of new Set([worktree, realPath(worktree)])) {
		if (file === from) return root;
		if (file.startsWith(from + path.sep)) return path.join(root, file.slice(from.length + 1));
	}
	return file;
}

/** The roots the parent passed to an isolated child, or undefined outside one. */
export function promptRootsFromEnv(env: NodeJS.ProcessEnv): PromptRoots | undefined {
	const worktree = env[WORKTREE_ROOT_ENV];
	const root = env[PROMPT_ROOT_ENV];
	return worktree && root ? { worktree, root } : undefined;
}
