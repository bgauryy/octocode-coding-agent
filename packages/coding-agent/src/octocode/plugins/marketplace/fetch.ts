import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalPaths } from "../../shared/home.ts";
import { MarketplaceError, redactUrl } from "./source.ts";

/** Marketplace state under the Octocode home: `plugins/marketplaces/<name>` and `plugins/cache/<marketplace>/<plugin>/<sha>`. */
export interface MarketplacePaths {
	/** `<home>/plugins`. */
	root: string;
	/** One folder per added git marketplace. */
	marketplaces: string;
	/** What each fetch recorded (`<name>.json`); outside the marketplace folders so a marketplace cannot shadow it. */
	meta: string;
	/** Installed plugin copies. */
	cache: string;
	/** Scratch space for fetches in progress. */
	tmp: string;
}

export function marketplacePaths(env: NodeJS.ProcessEnv = process.env, home?: string): MarketplacePaths {
	const root = path.join(globalPaths(env, home).home, "plugins");
	return {
		root,
		marketplaces: path.join(root, "marketplaces"),
		meta: path.join(root, "marketplaces", ".meta"),
		cache: path.join(root, "cache"),
		tmp: path.join(root, "tmp"),
	};
}

const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

/**
 * The environment of every git run: no prompt, no LFS smudge filter, and only the https, ssh, git and file transports
 * (this also covers `ext::` and submodule URLs). Variables that point git at another repository are dropped.
 */
function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const clean = { ...env };
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"])
		delete clean[name];
	return {
		...clean,
		GIT_TERMINAL_PROMPT: "0",
		GIT_LFS_SKIP_SMUDGE: "1",
		GIT_ALLOW_PROTOCOL: "https:ssh:git:file",
		GIT_ASKPASS: "",
		GIT_SSH_COMMAND: clean.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
	};
}

/** Configuration for one run: no repository hook, no remote helper, no LFS filter. A clone has no other way to run code. */
const SAFE_CONFIG = [
	`core.hooksPath=${os.devNull}`,
	"protocol.ext.allow=never",
	"filter.lfs.smudge=",
	"filter.lfs.process=",
	"filter.lfs.required=false",
	"core.fsmonitor=false",
].flatMap((setting) => ["-c", setting]);

export interface GitOptions {
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

function git(args: string[], options: GitOptions & { cwd?: string }): Promise<string> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			[...SAFE_CONFIG, ...args],
			{
				cwd: options.cwd,
				env: gitEnv(options.env ?? process.env),
				timeout: timeoutMs,
				killSignal: "SIGKILL",
				maxBuffer: 8 << 20,
			},
			(error, stdout, stderr) => {
				if (!error) return resolve(stdout.trim());
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") return reject(new MarketplaceError("git is not installed or not on PATH."));
				if ((error as { killed?: boolean }).killed)
					return reject(
						new MarketplaceError(`git ${args.at(-3) ?? "fetch"} timed out after ${Math.round(timeoutMs / 1000)}s.`),
					);
				const detail = redactUrl(stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ") || error.message);
				reject(new MarketplaceError(`git failed: ${detail}`));
			},
		);
	});
}

/** A directory is a git repository (working tree or bare) when git would open it; checked on disk, without running git. */
export function isGitRepository(dir: string): boolean {
	if (existsSync(path.join(dir, ".git"))) return true;
	return ["HEAD", "objects", "refs"].every((name) => existsSync(path.join(dir, name)));
}

/**
 * Shallow-clone `url` into `dest` (which must not exist) and return the commit checked out. `sha` fetches that exact
 * commit; otherwise `ref` or the default branch. Submodules and LFS objects are not fetched, no repository hook runs
 * and the `.git` folder is removed, so the result is plain files.
 */
export async function shallowClone(
	url: string,
	dest: string,
	options: GitOptions & { ref?: string; sha?: string },
): Promise<string> {
	mkdirSync(path.dirname(dest), { recursive: true });
	try {
		if (options.sha) {
			mkdirSync(dest);
			await git(["init", "-q"], { ...options, cwd: dest });
			await git(["fetch", "-q", "--depth", "1", "--no-recurse-submodules", "--no-tags", "--", url, options.sha], {
				...options,
				cwd: dest,
			});
			await git(["checkout", "-q", "--detach", "FETCH_HEAD"], { ...options, cwd: dest });
		} else {
			const branch = options.ref ? ["--branch", options.ref] : [];
			await git(
				["clone", "-q", "--depth", "1", "--no-recurse-submodules", "--no-tags", ...branch, "--", url, dest],
				options,
			);
		}
		const head = await git(["rev-parse", "HEAD"], { ...options, cwd: dest });
		rmSync(path.join(dest, ".git"), { recursive: true, force: true });
		return head;
	} catch (error) {
		rmSync(dest, { recursive: true, force: true });
		throw error;
	}
}
