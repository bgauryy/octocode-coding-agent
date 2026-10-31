import { type ExecFileException, execFile, spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { gitMarkerDir } from "../../utils/git-marker.ts";

export type GitPaths = {
	repoDir: string;
	commonGitDir: string;
	headPath: string;
};

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
export function findGitPaths(cwd: string): GitPaths | null {
	const dir = gitMarkerDir(cwd);
	if (dir === undefined) return null;
	const gitPath = join(dir, ".git");
	try {
		const stat = statSync(gitPath);
		if (stat.isFile()) {
			const content = readFileSync(gitPath, "utf8").trim();
			if (content.startsWith("gitdir: ")) {
				const gitDir = resolve(dir, content.slice(8).trim());
				const headPath = join(gitDir, "HEAD");
				if (!existsSync(headPath)) return null;
				const commonDirPath = join(gitDir, "commondir");
				const commonGitDir = existsSync(commonDirPath)
					? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
					: gitDir;
				return { repoDir: dir, commonGitDir, headPath };
			}
		} else if (stat.isDirectory()) {
			const headPath = join(gitPath, "HEAD");
			if (!existsSync(headPath)) return null;
			return { repoDir: dir, commonGitDir: gitPath, headPath };
		}
	} catch {
		return null;
	}
	// A `.git` that is neither a gitdir pointer nor a directory is not a repository.
	return null;
}

/** Ask git for the current branch. Returns null on detached HEAD or if git is unavailable. */
export function resolveBranchWithGitSync(repoDir: string): string | null {
	const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: repoDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const branch = result.status === 0 ? result.stdout.trim() : "";
	return branch || null;
}

/** Ask git for the current branch asynchronously. Returns null on detached HEAD or if git is unavailable. */
export function resolveBranchWithGitAsync(repoDir: string): Promise<string | null> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
			{
				cwd: repoDir,
				encoding: "utf8",
			},
			(error: ExecFileException | null, stdout: string) => {
				if (error) {
					resolvePromise(null);
					return;
				}
				const branch = stdout.trim();
				resolvePromise(branch || null);
			},
		);
	});
}

function isWslEnvironment(): boolean {
	return process.platform === "linux" && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function isWindowsMountedRepoPath(repoDir: string): boolean {
	return /^\/mnt\/[a-z](?:\/|$)/i.test(repoDir);
}

export function shouldPollGitHead(repoDir: string): boolean {
	return isWslEnvironment() && isWindowsMountedRepoPath(repoDir);
}

/** Fingerprint of the files that decide the current branch, or null when they cannot be read. */
export function readGitStateSignature(gitPaths: GitPaths | null | undefined): string | null {
	if (!gitPaths) return null;
	try {
		const parts = [readFileSync(gitPaths.headPath, "utf8")];
		const reftableDir = join(gitPaths.commonGitDir, "reftable");
		if (existsSync(reftableDir)) {
			parts.push(readdirSync(reftableDir).sort().join("\n"));
			const tablesListPath = join(reftableDir, "tables.list");
			parts.push(existsSync(tablesListPath) ? readFileSync(tablesListPath, "utf8") : "");
		}
		return parts.join("\0");
	} catch {
		return null;
	}
}
