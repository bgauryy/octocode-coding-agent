import fs from "node:fs";
import path from "node:path";
import { plural } from "@octocodeai/octocode-common/clip";
import { privateDir } from "@octocodeai/octocode-common/file-mode";
import { git, gitQuiet } from "../../utils/git-run.ts";
import { sessionDir, sessionsRoot } from "../shared/home.ts";
import { revokeWorktreeGrant } from "../trust/grants.ts";
import { worktreeBranch, worktreeNameProblem } from "./name.ts";
import { forgetWorktreeOpening, type OpeningScope } from "./openings.ts";
import { canonical, entryAt, locateRepo, worktreePath } from "./repo.ts";
import { dirtyCounts, insideWorktree, unmergedCount } from "./status.ts";

export interface RemoveResult {
	removed: boolean;
	/** What happened or what blocks, ready to show. */
	message: string;
}

/** What one session saved inside a worktree still owes: reports no session took yet, follow-up windows of finished children. */
interface HeldState {
	/** The session's folder name (its id as a folder). */
	session: string;
	/** The pending report files (`reports/pending/*.json`). */
	reports: string[];
	parked: number;
}

/** `readdirSync`, with a missing folder read as empty. */
function names(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** How many parked windows `<session folder>/parked-workers.json` records; none when there is no record. */
function parkedCount(folder: string): number {
	let text: string;
	try {
		text = fs.readFileSync(path.join(folder, "parked-workers.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
	const data: unknown = JSON.parse(text);
	return Array.isArray(data) ? data.length : 0;
}

/**
 * The sessions that ran in worktree `target` and still hold undelivered state. A linked worktree is its own workspace
 * data root, so their session data lives inside it and goes with it.
 */
function heldState(target: string): HeldState[] {
	const root = sessionsRoot(process.env, target);
	return names(root).flatMap((session) => {
		const folder = path.join(root, session);
		const pending = path.join(folder, "reports", "pending");
		const reports = names(pending)
			.filter((name) => name.endsWith(".json"))
			.map((name) => path.join(pending, name));
		const parked = parkedCount(folder);
		return reports.length > 0 || parked > 0 ? [{ session, reports, parked }] : [];
	});
}

function heldText(held: readonly HeldState[]): string {
	return held
		.map((state) =>
			[
				state.reports.length > 0 ? plural(state.reports.length, "undelivered subagent report") : "",
				state.parked > 0 ? plural(state.parked, "parked agent window") : "",
			]
				.filter(Boolean)
				.join(" and ")
				.concat(` in session ${state.session}`),
		)
		.join("; ");
}

/** Copies each held session's pending reports to the same session's pending folder under the main checkout; returns how many. */
function copyReports(held: readonly HeldState[], main: string): number {
	let copied = 0;
	for (const { session, reports } of held) {
		if (reports.length === 0) continue;
		const dest = privateDir(path.join(sessionDir(session, process.env, main), "reports", "pending"));
		for (const file of reports) {
			fs.copyFileSync(file, path.join(dest, path.basename(file)), fs.constants.COPYFILE_EXCL);
			copied++;
		}
	}
	return copied;
}

export interface RemoveOptions {
	force?: boolean;
	sessionCwd?: string;
	/** Where the worktree's recorded opener is dropped once it is removed. */
	openings?: OpeningScope;
	/**
	 * Who is working in `target`, given every live worktree root: `agents: …; tmux: …` or nothing. Without `force` a
	 * worktree with occupants stays.
	 */
	occupants?: (target: string, roots: string[]) => Promise<string | undefined>;
}

/**
 * Removes `<main root>/.octocode/worktrees/<name>`. Without `force` it refuses a worktree with changed or untracked
 * files, with commits no other branch has, with occupants (`options.occupants`), or whose sessions still hold undelivered
 * subagent reports or parked agent windows, and says which. With `force` it first copies those reports to the same
 * sessions under the main checkout. It never removes the worktree `sessionCwd` is in. The branch goes only through
 * `git branch -d`, so an unmerged one stays.
 */
export async function removeWorktree(cwd: string, name: string, options: RemoveOptions = {}): Promise<RemoveResult> {
	const problem = worktreeNameProblem(name);
	if (problem) return { removed: false, message: problem };
	const repo = await locateRepo(cwd);
	const target = worktreePath(repo.main, name);
	const entry = entryAt(repo.entries, target);
	if (!entry) return { removed: false, message: `No worktree "${name}" under ${worktreePath(repo.main, "")}.` };
	if (insideWorktree(options.sessionCwd ?? cwd, target))
		return { removed: false, message: `This session runs in worktree "${name}"; remove it from another checkout.` };

	if (!entry.prunable && !options.force) {
		const roots = repo.entries.filter((candidate) => !candidate.prunable).map((candidate) => candidate.path);
		const here = await options.occupants?.(target, roots);
		if (here)
			return {
				removed: false,
				message: `Worktree "${name}" is in use (${here}). Close them, or run /worktree remove ${name} --force.`,
			};
		const held = heldState(target);
		if (held.length > 0)
			return {
				removed: false,
				message: `Worktree "${name}" holds ${heldText(held)}. Resume those sessions in the worktree to receive them, or run /worktree remove ${name} --force to copy the reports to the main checkout and discard the rest.`,
			};
		const { dirty, untracked } = await dirtyCounts(target);
		const unmerged = await unmergedCount(entry);
		const blockers = [
			dirty > 0 ? plural(dirty, "changed file") : "",
			untracked > 0 ? plural(untracked, "untracked file") : "",
			unmerged > 0 ? `${plural(unmerged, "commit")} not on any other branch` : "",
		].filter(Boolean);
		if (blockers.length > 0)
			return {
				removed: false,
				message: `Worktree "${name}" has ${blockers.join(", ")}. Run /worktree remove ${name} --force to discard them.`,
			};
	}

	// Before anything is deleted: a copy that fails leaves the worktree as it was.
	const moved = !entry.prunable && options.force ? copyReports(heldState(target), repo.main) : 0;
	const kept = moved > 0 ? ` Copied ${plural(moved, "undelivered subagent report")} to the main checkout.` : "";
	// Resolved while the folder exists: afterwards a symlinked path no longer resolves to the recorded one.
	const recorded = canonical(target);
	// A registered worktree whose folder is gone has nothing to remove: pruning drops the entry.
	await git(
		repo.main,
		entry.prunable ? ["worktree", "prune"] : ["worktree", "remove", ...(options.force ? ["--force"] : []), target],
	);
	revokeWorktreeGrant(target); // the grant of a worktree that no longer exists
	forgetWorktreeOpening(recorded, options.openings);
	const branch = worktreeBranch(name);
	if (entry.branch !== branch) return { removed: true, message: `Removed worktree "${name}".${kept}` };
	const deleted = await gitQuiet(repo.main, ["branch", "-d", branch]);
	return {
		removed: true,
		message:
			deleted === undefined
				? `Removed worktree "${name}". Kept branch ${branch}: it has commits that are not merged (delete it with git branch -D ${branch}).${kept}`
				: `Removed worktree "${name}" and its branch ${branch}.${kept}`,
	};
}
