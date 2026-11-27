import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { inAgentState } from "../storage/agent-layout.ts";
import { EXCLUDE_WORKSPACE_STATE, git as runGit, GitError } from "./git-run.ts";

const MAX_OUTPUT = 128_000;
export interface RepositoryDiff {
	root: string;
	staged: string;
	unstaged: string;
	untracked: string[];
	truncated: boolean;
	selectedUntracked?: string;
}

async function git(
	cwd: string,
	args: string[],
	signal?: AbortSignal,
	options?: { configuration?: string[]; allowMissing?: boolean },
): Promise<{ text: string; truncated: boolean }> {
	try {
		const text = await runGit(cwd, ["--no-pager", ...(options?.configuration ?? []), ...args], {
			signal,
			timeoutMs: 15_000,
			maxBuffer: MAX_OUTPUT,
			raw: true,
			env: { GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "", GIT_CONFIG_COUNT: "0" },
		});
		return { text: text.slice(0, MAX_OUTPUT), truncated: false };
	} catch (error) {
		if (signal?.aborted) throw new Error("Diff cancelled.", { cause: error });
		if (error instanceof GitError) {
			if (error.exitCode === 1 && options?.allowMissing) return { text: "", truncated: false };
			if (error.overflow) return { text: error.stdout.slice(0, MAX_OUTPUT), truncated: true };
		}
		throw error;
	}
}

/** Git can execute clean/process filters even when external diff and textconv are disabled. */
async function disabledFilters(root: string, signal?: AbortSignal): Promise<string[]> {
	const result = await git(
		root,
		["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"],
		signal,
		{ allowMissing: true },
	);
	if (result.truncated) throw new Error("Git filter configuration is too large to inspect safely.");
	return result.text
		.split("\0")
		.filter(Boolean)
		.flatMap((key) => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]);
}

function within(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function selectedPath(root: string, cwd: string, selection: string): Promise<string> {
	const absolute = path.resolve(cwd, selection);
	if (!within(root, absolute)) throw new Error("Diff paths must be inside the repository.");
	let existing = absolute;
	for (;;) {
		try {
			const real = await realpath(existing);
			if (inAgentState(path.relative(root, real))) throw new Error("Repository diff excludes private workspace state.");
			if (!within(root, real)) throw new Error("The selected path resolves outside the repository.");
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = path.dirname(existing);
			if (parent === existing) throw error;
			existing = parent;
		}
	}
	return path.relative(root, absolute) || ".";
}

export async function readRepositoryDiff(
	cwd: string,
	selection?: string,
	signal?: AbortSignal,
): Promise<RepositoryDiff> {
	let root: string;
	try {
		root = await realpath((await git(cwd, ["rev-parse", "--show-toplevel"], signal)).text.trim());
	} catch {
		signal?.throwIfAborted();
		throw new Error("Repository diff is unavailable outside a Git working tree.");
	}
	const workingDirectory = await realpath(cwd);
	const selected = selection ? await selectedPath(root, workingDirectory, selection) : undefined;
	const paths = selected ? [`:(literal)${selected}`, ...EXCLUDE_WORKSPACE_STATE] : [...EXCLUDE_WORKSPACE_STATE];
	const configuration = await disabledFilters(root, signal);
	const flags = [
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		"--submodule=short",
		"--find-renames",
		"--stat",
		"--patch",
	];
	const [staged, unstaged, untracked] = await Promise.all([
		git(root, ["diff", "--cached", ...flags, "--", ...paths], signal, { configuration }),
		git(root, ["diff", ...flags, "--", ...paths], signal, { configuration }),
		git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths], signal),
	]);
	const names = untracked.text.split("\0");
	names.pop(); // An incomplete final filename from truncated output is never selectable.
	return {
		root,
		selectedUntracked: selected && names.includes(selected) ? selected : undefined,
		staged: staged.text,
		unstaged: unstaged.text,
		untracked: names,
		truncated: staged.truncated || unstaged.truncated || untracked.truncated,
	};
}

/** Untracked files are read only after explicit selection, never through a symlink. */
export async function readUntrackedDiff(rootPath: string, file: string): Promise<string> {
	const root = await realpath(rootPath);
	const relative = await selectedPath(root, root, file);
	const target = path.join(root, relative);
	const stat = await lstat(target);
	if (!stat.isFile()) return "Untracked path is not a regular file; contents were not read.";
	const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		if (!within(root, await realpath(target))) throw new Error("Untracked file moved outside the repository.");
		const current = await handle.stat();
		if (!current.isFile()) throw new Error("Untracked path is no longer a regular file.");
		if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error("File changed while opening the diff.");
		const buffer = Buffer.alloc(Math.min(MAX_OUTPUT, current.size));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const data = buffer.subarray(0, bytesRead);
		if (data.includes(0)) return "Binary untracked file; contents were not displayed.";
		return data.toString("utf8") + (current.size > bytesRead ? "\n[Untracked file truncated.]" : "");
	} finally {
		await handle.close();
	}
}
