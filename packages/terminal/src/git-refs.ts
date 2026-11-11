import { readdir, readFile, stat } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { dirname, join, resolve } from "node:path";

/** git subcommands whose next argument is usually a branch. */
export const BRANCH_SUBCOMMANDS = new Set([
	"checkout",
	"switch",
	"merge",
	"rebase",
	"branch",
	"diff",
	"log",
	"cherry-pick",
	"reset",
	"push",
	"pull",
	"show",
	"worktree",
]);

/** The `.git` directory and the common directory that holds refs for `cwd`'s repository, or undefined. */
async function gitDirs(cwd: string, signal?: AbortSignal): Promise<{ gitDir: string; commonDir: string } | undefined> {
	let dir = resolve(cwd);
	for (;;) {
		if (signal?.aborted) return undefined;
		const dotGit = join(dir, ".git");
		try {
			const info = await stat(dotGit);
			let gitDir = dotGit;
			if (info.isFile()) {
				const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, { encoding: "utf8", signal }))?.[1]?.trim();
				if (!pointer) return undefined;
				gitDir = resolve(dir, pointer);
			}
			let commonDir = gitDir;
			try {
				commonDir = resolve(gitDir, (await readFile(join(gitDir, "commondir"), { encoding: "utf8", signal })).trim());
			} catch {
				// Not a linked worktree.
			}
			return { gitDir, commonDir };
		} catch {
			const parent = dirname(dir);
			if (parent === dir) return undefined;
			dir = parent;
		}
	}
}

async function walk(root: string, prefix: string, out: Set<string>, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (signal?.aborted) return;
		const name = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) await walk(join(root, entry.name), name, out, signal);
		else if (entry.isFile()) out.add(name);
	}
}

/**
 * Local branch names of the repository at `cwd`, read from `refs/heads` and `packed-refs`. No `git` process runs: a
 * repository's configuration can make git run programs, so this is safe in a folder the user has not trusted.
 */
export async function gitBranches(cwd: string, signal?: AbortSignal): Promise<string[]> {
	const dirs = await gitDirs(cwd, signal);
	if (!dirs) return [];
	const names = new Set<string>();
	await walk(join(dirs.commonDir, "refs", "heads"), "", names, signal);
	try {
		const packed = await readFile(join(dirs.commonDir, "packed-refs"), { encoding: "utf8", signal });
		let count = 0;
		for (const match of packed.matchAll(/[^\n]+/g)) {
			if (signal?.aborted) return [];
			if (++count % 256 === 0) await setImmediate();
			const line = match[0];
			const ref = /^[0-9a-f]{40,64} refs\/heads\/(.+)$/.exec(line.trim())?.[1];
			if (ref) names.add(ref);
		}
	} catch {
		// No packed refs.
	}
	return [...names].sort();
}
