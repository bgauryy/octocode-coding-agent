/**
 * Startup checks for an auth.json that exposes API keys: readable by other users, or inside a git work tree where a
 * commit could publish it.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface AuthFileSafetyOptions {
	platform?: NodeJS.Platform;
}

function findGitWorkTree(startDir: string): string | undefined {
	let dir = resolve(startDir);
	for (;;) {
		// A `.git` directory marks a repository; a `.git` file marks a linked work tree or submodule.
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Warnings about `authPath`; empty when the file is missing or safe. */
export function checkAuthFileSafety(authPath: string, options: AuthFileSafetyOptions = {}): string[] {
	const platform = options.platform ?? process.platform;
	let mode: number;
	try {
		mode = statSync(authPath).mode;
	} catch {
		return [];
	}
	const warnings: string[] = [];
	if (platform !== "win32" && (mode & 0o077) !== 0) {
		warnings.push(
			`${authPath} is readable by other users (mode ${(mode & 0o777).toString(8)}) and may hold API keys. Run: chmod 600 ${authPath}`,
		);
	}
	const workTree = findGitWorkTree(dirname(authPath));
	if (workTree) {
		warnings.push(
			`${authPath} is inside the git work tree ${workTree}; add it to .gitignore so API keys are not committed, or store keys in the system keychain with /providers.`,
		);
	}
	return warnings;
}
