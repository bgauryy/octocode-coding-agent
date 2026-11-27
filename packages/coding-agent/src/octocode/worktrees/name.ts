/** Letters, digits, `.`, `_` and `-`, 1 to 64 characters: the name is a folder and a branch suffix. */
const WORKTREE_NAME = /^[A-Za-z0-9._-]{1,64}$/u;

/**
 * Why `name` cannot name a worktree, or undefined when it can. `..`, a trailing `.` or `.lock` make the branch name one git
 * refuses; a leading `-` reads as an option to the commands that take the name.
 */
export function worktreeNameProblem(name: string): string | undefined {
	const unsafe = name.startsWith("-") || name.endsWith(".") || name.endsWith(".lock") || name.includes("..");
	if (unsafe || !WORKTREE_NAME.test(name))
		return `Invalid worktree name "${name}": use 1 to 64 letters, digits, ".", "_" or "-" (not starting with "-", no "..", not ending in "." or ".lock").`;
	return undefined;
}

/** The branch a worktree of this name works on. */
export const worktreeBranch = (name: string): string => `worktree-${name}`;
