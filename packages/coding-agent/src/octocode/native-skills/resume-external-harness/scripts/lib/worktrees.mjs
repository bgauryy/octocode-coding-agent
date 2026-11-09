// The repository's worktrees: those git registers (live, missing or locked) and folders other harnesses
// created for it that git no longer tracks. Read-only: it suggests prune, repair or remove, never runs them.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { exists, readText, real } from "./common.mjs";

function git(cwd, args) {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

/** `git worktree list --porcelain` as records; the first is the main worktree. */
function registeredWorktrees(root) {
	const out = git(root, ["worktree", "list", "--porcelain"]);
	if (!out) return [];
	return out.split(/\n\n+/).map((block) => {
		const record = {};
		for (const line of block.split("\n")) {
			const [key, ...rest] = line.split(" ");
			record[key] = rest.length ? rest.join(" ") : true;
		}
		return {
			path: record.worktree,
			head: record.HEAD,
			branch: typeof record.branch === "string" ? record.branch.replace(/^refs\/heads\//, "") : undefined,
			detached: record.detached === true,
			locked: record.locked === undefined ? undefined : record.locked === true ? "locked" : record.locked,
			prunable: record.prunable === undefined ? undefined : record.prunable === true ? "prunable" : record.prunable,
		};
	});
}

/** The `.git` file of a linked worktree points at <common dir>/worktrees/<name>. */
function gitdirOf(dir) {
	const file = join(dir, ".git");
	if (!exists(file) || statSync(file).isDirectory()) return undefined;
	const target = readText(file)
		.match(/^gitdir:\s*(.+)$/m)?.[1]
		?.trim();
	return target ? resolve(dir, target) : undefined;
}

const children = (dir) =>
	exists(dir)
		? readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(dir, entry.name))
		: [];

/** Folders where Claude Code, Cursor, Codex and Octocode put worktrees they create for a repository. */
function harnessWorktreeDirs(ctx) {
	const name = basename(ctx.root);
	return [
		...children(join(ctx.root, ".claude", "worktrees")),
		...children(join(ctx.root, ".octocode", "worktrees")),
		...children(join(ctx.home, ".cursor", "worktrees", name)),
		...children(join(ctx.home, ".codex", "worktrees")).flatMap((dir) => [dir, ...children(dir)]),
	];
}

/** Every worktree of the repository at `ctx.root`, with `kind` root, worktree or unregistered. */
export function worktrees(ctx) {
	const common = git(ctx.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const registered = registeredWorktrees(ctx.root).map((entry, index) => ({
		...entry,
		path: real(entry.path),
		kind: index === 0 ? "root" : "worktree",
		missing: !exists(entry.path),
	}));
	if (!registered.length) return [{ path: ctx.root, kind: "root", missing: false }];
	const known = new Set(registered.map((entry) => entry.path));
	const unregistered = [];
	if (common) {
		for (const dir of harnessWorktreeDirs(ctx)) {
			const gitdir = gitdirOf(dir);
			if (!gitdir || dirname(gitdir) !== join(common, "worktrees") || known.has(real(dir))) continue;
			known.add(real(dir));
			unregistered.push({
				path: real(dir),
				kind: "unregistered",
				missing: false,
				gitdir,
				gitdirExists: exists(gitdir),
			});
		}
	}
	return [...registered, ...unregistered];
}

/** The branch work is measured against: origin's default branch, else main or master, else the root's branch. */
export function baseRef(ctx, rootBranch) {
	const remote = git(ctx.root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
	if (remote) return remote;
	for (const name of ["main", "master"]) if (git(ctx.root, ["rev-parse", "--verify", "-q", name])) return name;
	return rootBranch;
}

/** State of one worktree: changes, commits ahead of and behind `base`, last commit, and what to do with it. */
export function inspectWorktree(ctx, tree, base) {
	const head = tree.head ?? (tree.missing ? undefined : git(tree.path, ["rev-parse", "HEAD"]));
	const state = { ...tree, head, base };
	if (!tree.missing) {
		const status = git(tree.path, ["status", "--porcelain=v1"]);
		state.changedFiles = status === undefined ? undefined : status ? status.split("\n").length : 0;
		state.branch ??= git(tree.path, ["branch", "--show-current"]) || undefined;
	}
	if (head) {
		state.lastCommitAt = git(ctx.root, ["log", "-1", "--format=%cI", head]);
		const counts = base && git(ctx.root, ["rev-list", "--left-right", "--count", `${base}...${head}`]);
		if (counts) [state.behind, state.ahead] = counts.split(/\s+/).map(Number);
	}
	state.advice = advise(state);
	return state;
}

function advise(tree) {
	const { path, branch, head, ahead = 0, changedFiles = 0, base } = tree;
	const rescue = !branch && head && ahead > 0 ? `\`git branch rescue/${basename(path)} ${head.slice(0, 12)}\`` : "";
	const keep = rescue ? `${rescue} (keeps its ${ahead} unmerged commits reachable), then ` : "";
	if (tree.kind === "root") return { state: "root", action: "" };
	if (tree.locked)
		return { state: "locked", action: `Leave it: locked (${tree.locked}). Unlock only if its owner is gone.` };
	if (tree.kind === "unregistered") {
		return {
			state: "dangling",
			action: tree.gitdirExists
				? `git no longer lists it: \`git worktree repair ${path}\` re-links it.`
				: `Its git metadata is gone: \`git worktree repair ${path}\` from the root re-links it; or copy its changes out and delete the folder.`,
		};
	}
	if (tree.missing) {
		return {
			state: "dangling",
			action: `Folder deleted, git still lists it: ${keep}\`git worktree prune\`${branch ? ` (branch ${branch} stays)` : ""}; or \`git worktree add ${path} ${branch ?? head?.slice(0, 12) ?? "<ref>"}\` to restore it and resume there.`,
		};
	}
	if (changedFiles > 0)
		return {
			state: "uncommitted",
			action: `${changedFiles} changed files: resume its session there, or commit or stash them.`,
		};
	if (ahead > 0) {
		const detached = rescue
			? ` Its HEAD is detached: run ${rescue} before removing it, or the commits become unreachable.`
			: "";
		return {
			state: "unmerged",
			action: `${ahead} commits not in ${base}: merge, open a pull request or keep working there.${detached}`,
		};
	}
	return {
		state: "merged",
		action: `Clean and contained in ${base ?? "the base"}: ${keep}\`git worktree remove ${path}\` is safe.`,
	};
}
