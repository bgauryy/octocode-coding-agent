import { execFileSync } from "node:child_process";

/**
 * `git` for code that cannot wait (path resolution, permission checks on a synchronous path): stdout as git wrote it,
 * stderr dropped, a mandatory `timeoutMs`. Throws when git fails or times out.
 */
export function gitSync(
	cwd: string,
	args: readonly string[],
	options: { timeoutMs: number; maxBuffer?: number },
): string {
	// A launcher or Git hook can export its own checkout. These reads address the directory supplied by the caller.
	const env = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
	return execFileSync("git", [...args], {
		env,
		cwd,
		encoding: "utf8",
		timeout: options.timeoutMs,
		...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true,
	});
}
