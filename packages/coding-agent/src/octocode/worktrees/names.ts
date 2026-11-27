import { readdirSync } from "node:fs";
import path from "node:path";
import { repoKey } from "../../utils/git-repository.ts";
import { worktreesFolder } from "./repo.ts";

/**
 * The names under `<main>/.octocode/agent/worktrees` of the repository the session folder `cwd` is in, for completion. It reads
 * the folder and the cached `repoKey` (no git process per keystroke): the main checkout is the parent of the common git
 * dir. Empty outside a repository, in a bare one, or when the folder is missing.
 */
export function worktreeNames(cwd: string): string[] {
	const common = repoKey(cwd).key;
	if (path.basename(common) !== ".git") return [];
	try {
		return readdirSync(worktreesFolder(path.dirname(common)), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}
