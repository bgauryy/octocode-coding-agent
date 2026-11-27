import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The nearest directory at or above `from` that holds a `.git` entry (a directory in a repository, a file in a
 * worktree or submodule), or undefined without one. A walk over names only: it runs no git and judges no repository.
 */
export function gitMarkerDir(from: string): string | undefined {
	for (let dir = resolve(from); ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return undefined;
	}
}
