import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWriteFileSync, shortHash } from "../../utils/atomic-file.ts";
import { repoKey } from "../shared/home/repo.ts";
import { errorMessage } from "../../utils/guards.ts";
import { claimSuffix, releaseDeadClaims } from "../shared/claims.ts";
import { HOME_NAMES, octocodeHome } from "../shared/home.ts";
import { processStartTime, sameProcess } from "../shared/process.ts";
import {
	recoverWorktreeBase,
	saveWorkerRef,
	snapshotWorkingCopy,
	validateSnapshot,
	workerDeltaCommit,
} from "./worktree-snapshot.ts";

/**
 * Git worktree isolation for implementer subagents, adapted from the native host's worker worktrees: each isolated
 * subagent works in a detached worktree under `<Octocode home>/worktrees/<repo-hash>/<agent-id>`; on finish its
 * changes are committed to `refs/octocode/<agent-id>` and the worktree is removed; when saving fails the worktree is
 * kept so nothing is lost. Merging stays manual (`/agents merge`).
 * Ignored files (`node_modules`, builds) are not in the worktree.
 */

const REF_PREFIX = "refs/octocode/";
/** Where an earlier version saved results; they are still listed and merged, never written. */
const LEGACY_REF_PREFIX = "refs/octocode/pi/";
/** Commits and merges made here never run the repository's hooks. */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];
const ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			maxBuffer: 16 * 1024 * 1024,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		return stdout.trimEnd();
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Error(stderr || errorMessage(error));
	}
}

const quiet = (work: Promise<string>): Promise<string | undefined> => work.catch(() => undefined);

export interface Worktree {
	agentId: string;
	/** Main repository root. */
	repo: string;
	/** The worktree directory. */
	path: string;
	/** The commit the worktree started from. */
	base: string;
	/** A private commit capturing the parent's working files when explicitly requested. */
	snapshot?: string;
	/** Where the subagent runs: the worktree, at the same subdirectory as the parent's cwd. */
	cwd: string;
	/** Set when the main tree had uncommitted changes, which the worktree does not see. */
	warning?: string;
}

interface WorktreeResult {
	/** The private ref holding the subagent's changes; absent when it changed nothing. */
	ref?: string;
	/** `git diff --stat` of those changes. */
	stat?: string;
}

export function worktreesDir(repo: string, home = octocodeHome()): string {
	return path.join(home, HOME_NAMES.worktrees, shortHash(repo));
}

/** The repository root, the same `repoKey` root the team workspace uses, so both always agree. */
function repoRoot(cwd: string): string {
	const { root } = repoKey(cwd);
	if (!fs.existsSync(path.join(root, ".git")))
		throw new Error("isolate needs a git repository; run without isolate here.");
	return root;
}

/** Creates a detached worktree at HEAD, or at an explicit snapshot of the current working files. */
export async function createWorktree(
	cwd: string,
	agentId: string,
	home = octocodeHome(),
	workingCopy = false,
): Promise<Worktree> {
	if (!ID_PATTERN.test(agentId)) throw new Error(`Invalid agent id "${agentId}"`);
	const repo = repoRoot(cwd);
	const base = await quiet(git(repo, ["rev-parse", "--verify", "HEAD"]));
	if (!base) throw new Error("isolate needs at least one commit to start the worktree from.");
	const dirty = workingCopy ? "" : await git(repo, ["status", "--porcelain"]);
	const dir = worktreesDir(repo, home);
	const worktree = path.join(dir, agentId);
	fs.mkdirSync(dir, { recursive: true });
	// Never reuse a kept worktree's id: overwriting (then removing) its record would hide it from prune and reports.
	if (fs.existsSync(worktree) || fs.existsSync(`${worktree}.json`))
		throw new Error(`A worktree for ${agentId} already exists at ${worktree}; start the agent again for a new id.`);
	const snapshot = workingCopy ? await snapshotWorkingCopy(repo, base) : undefined;
	// The owner record lets a later session prune worktrees whose parent process died.
	atomicWriteFileSync(
		`${worktree}.json`,
		JSON.stringify({
			owners: [owner(process.pid)],
			repo,
			base,
			...(snapshot ? { snapshot } : {}),
			createdAt: Date.now(),
		}),
	);
	try {
		await git(repo, ["worktree", "add", "--detach", worktree, snapshot ?? base]);
	} catch (error) {
		fs.rmSync(`${worktree}.json`, { force: true });
		throw error;
	}
	const sub = path.relative(repo, path.resolve(cwd));
	const childCwd =
		sub && !sub.startsWith("..") && fs.existsSync(path.join(worktree, sub)) ? path.join(worktree, sub) : worktree;
	return {
		agentId,
		repo,
		path: worktree,
		base,
		...(snapshot ? { snapshot } : {}),
		cwd: childCwd,
		...(dirty && !snapshot
			? { warning: "The main tree has uncommitted changes; the isolated subagent starts from HEAD without them." }
			: {}),
	};
}

/** Adds the subagent's own process to the owner record, so a parent crash does not let a prune remove the worktree under a live child. */
export function recordWorktreePid(worktree: Pick<Worktree, "path">, pid: number): void {
	const meta = `${worktree.path}.json`;
	try {
		const record = JSON.parse(fs.readFileSync(meta, "utf8")) as Record<string, unknown>;
		atomicWriteFileSync(
			meta,
			JSON.stringify({ ...record, owners: [...ownersOf(record).filter((each) => each.pid !== pid), owner(pid)] }),
		);
	} catch {
		// The record is gone: the worktree was already finished.
	}
}

/** A process that keeps a worktree: its pid and start time, so a later process that reused the pid does not keep it forever. */
interface Owner {
	pid: number;
	started?: string;
}

const owner = (pid: number): Owner => {
	const started = processStartTime(pid);
	return started ? { pid, started } : { pid };
};

/** The owners in a record; an owner without a start time (unknown where it ran) is judged by the pid alone. */
function ownersOf(record: { owners?: unknown }): Owner[] {
	const listed = Array.isArray(record.owners) ? record.owners : [];
	return listed.flatMap((each: unknown) => {
		if (typeof each !== "object" || each === null) return [];
		const { pid, started } = each as { pid?: unknown; started?: unknown };
		return typeof pid === "number" ? [typeof started === "string" ? { pid, started } : { pid }] : [];
	});
}

/** An owner record this young that cannot be read may be mid-write by another session: leave its worktree alone. */
const UNREADABLE_GRACE_MS = 60_000;

/**
 * Commits whatever changed in the worktree to the agent's private ref, then removes the worktree. The worktree is
 * removed only once its changes are safe on the ref (or it changed nothing); when saving fails it is kept, with its
 * owner record, and the error names where it is.
 */
export async function finishWorktree(
	worktree: Pick<Worktree, "agentId" | "repo" | "path" | "base" | "snapshot">,
): Promise<WorktreeResult> {
	if (!fs.existsSync(worktree.path)) {
		await removeWorktree(worktree);
		return {};
	}
	if (fs.lstatSync(worktree.path).isSymbolicLink())
		throw new Error(`Worktree path is a symbolic link: ${worktree.path}`);
	let result: WorktreeResult;
	try {
		result = await saveChanges(worktree);
	} catch (error) {
		throw new Error(
			`${errorMessage(error)}. The worktree is kept at ${worktree.path}; commit or copy its changes, then remove it with \`git worktree remove --force ${worktree.path}\`.`,
		);
	}
	await removeWorktree(worktree);
	return result;
}

async function saveChanges(
	worktree: Pick<Worktree, "agentId" | "repo" | "path" | "base" | "snapshot">,
): Promise<WorktreeResult> {
	if (await git(worktree.path, ["status", "--porcelain"])) {
		await git(worktree.path, ["add", "-A"]);
		const identity = (await quiet(git(worktree.path, ["config", "user.email"])))
			? []
			: ["-c", "user.name=Octocode", "-c", "user.email=octocode@localhost"];
		await git(worktree.path, [
			...NO_HOOKS,
			...identity,
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--no-verify",
			"-q",
			"-m",
			`octocode subagent ${worktree.agentId}`,
		]);
		// Anything still uncommitted (a failed partial commit) would be lost with the worktree.
		if (await git(worktree.path, ["status", "--porcelain"]))
			throw new Error("Uncommitted changes remain after the commit");
	}
	const head = await git(worktree.path, ["rev-parse", "HEAD"]);
	const base = worktree.base || (await recoverWorktreeBase(worktree.repo, head));
	await validateSnapshot(worktree.repo, base, worktree.snapshot, head);
	if (head === (worktree.snapshot ?? base)) return {};
	const delta = worktree.snapshot
		? await workerDeltaCommit(worktree.repo, base, worktree.snapshot, head, worktree.agentId)
		: head;
	if (delta === base) return {};
	const ref = await saveWorkerRef(worktree.repo, `${REF_PREFIX}${worktree.agentId}`, delta);
	return { ref, stat: await git(worktree.repo, ["diff", "--stat", base, delta]) };
}

async function removeWorktree(worktree: Pick<Worktree, "repo" | "path">): Promise<void> {
	if ((await quiet(git(worktree.repo, ["worktree", "remove", "--force", worktree.path]))) === undefined) {
		fs.rmSync(worktree.path, { recursive: true, force: true });
		await quiet(git(worktree.repo, ["worktree", "prune"]));
	}
	fs.rmSync(`${worktree.path}.json`, { force: true });
}

/** The lines appended to an isolated subagent's report. */
export function isolationReport(agentId: string, result: WorktreeResult | { error: string }): string {
	if ("error" in result) return `\n\nIsolated worktree for ${agentId} could not be saved: ${result.error}`;
	if (!result.ref) return `\n\nIsolated run ${agentId} changed no files.`;
	return `\n\nIsolated changes are on ${result.ref}, not in this tree:\n${result.stat}\nMerge with \`/agents merge ${result.ref.slice(REF_PREFIX.length)}\` or \`git merge --no-ff ${result.ref}\`.`;
}

/** The agent's saved ref under the current path, else the legacy one, else undefined. */
async function savedRef(repo: string, agentId: string): Promise<string | undefined> {
	const [ref, legacy] = [REF_PREFIX, LEGACY_REF_PREFIX].map((prefix) => `${prefix}${agentId}`);
	const exists = (candidate: string) => quiet(git(repo, ["rev-parse", "--verify", "--quiet", candidate]));
	return (await exists(ref)) ? ref : (await exists(legacy)) ? legacy : undefined;
}

/** Merges an isolated subagent's ref into the main tree with hooks disabled; on conflict aborts and lists the paths. */
export async function mergeAgent(cwd: string, agentId: string): Promise<{ ok: boolean; text: string }> {
	if (!ID_PATTERN.test(agentId)) return { ok: false, text: `Invalid agent id "${agentId}"` };
	const repo = repoRoot(cwd);
	const ref = await savedRef(repo, agentId);
	if (!ref) return { ok: false, text: `No isolated changes for ${agentId} (${REF_PREFIX}${agentId} does not exist).` };
	if (await quiet(git(repo, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]))) {
		return {
			ok: false,
			text: `A merge is already in progress. Finish or abort it before merging ${ref}; your resolution and the agent ref are kept.`,
		};
	}
	try {
		await git(repo, [...NO_HOOKS, "merge", "--no-ff", "--no-edit", ref]);
	} catch (error) {
		const conflicts = (await quiet(git(repo, ["diff", "--name-only", "--diff-filter=U"]))) ?? "";
		if (await quiet(git(repo, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]))) {
			if ((await quiet(git(repo, ["merge", "--abort"]))) === undefined) {
				return {
					ok: false,
					text: `Merging ${ref} failed and could not be aborted. The merge is still in progress; inspect git status before continuing. ${ref} is kept.\n${errorMessage(error)}`,
				};
			}
		}
		if (conflicts)
			return {
				ok: false,
				text: `Merging ${ref} conflicts in:\n${conflicts}\nThe merge was aborted and the tree is unchanged; ${ref} is kept.`,
			};
		return { ok: false, text: `Merging ${ref} failed: ${errorMessage(error)}` };
	}
	await quiet(git(repo, ["update-ref", "-d", ref]));
	return {
		ok: true,
		text: `Merged ${ref} into ${(await quiet(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]))) ?? "HEAD"}.`,
	};
}

/** Agent ids of isolated results not merged yet, under the current ref path or the legacy one. */
export async function pendingRefs(cwd: string): Promise<string[]> {
	const out = (await quiet(git(cwd, ["for-each-ref", "--format=%(refname)", REF_PREFIX]))) ?? "";
	const id = (ref: string) => ref.slice((ref.startsWith(LEGACY_REF_PREFIX) ? LEGACY_REF_PREFIX : REF_PREFIX).length);
	return [...new Set(out.split("\n").filter(Boolean).map(id))];
}

interface PruneReport {
	/** Orphaned worktrees removed after their changes were saved; `ref` is absent when one changed nothing. */
	saved: Array<{ agentId: string; ref?: string }>;
	/** Orphaned worktrees kept because their changes could not be saved. */
	kept: Array<{ agentId: string; error: string }>;
}

/** An owner record being pruned is renamed `<agent>.json.pruning-<pid>-<start time>` by the session that claimed it (`shared/claims.ts`). */
const CLAIM_MARKER = ".pruning-";

/**
 * Removes worktrees of this repository whose owning Octocode processes (parent and subagent) are all gone. Their changes are
 * first committed to the agent's ref; a worktree whose changes cannot be saved is kept and reported, so a crash never
 * loses an isolated subagent's work. A call while a prune of the same repository runs in this process joins it: two
 * would only contend for git's index lock (other processes are kept apart by the rename claim).
 */
export function pruneWorktrees(cwd: string, home = octocodeHome()): Promise<PruneReport> {
	let repo: string;
	try {
		repo = repoRoot(cwd);
	} catch {
		return Promise.resolve({ saved: [], kept: [] });
	}
	const dir = worktreesDir(repo, home);
	const running = pruning.get(dir);
	if (running) return running;
	const prune = pruneDir(repo, dir).finally(() => pruning.delete(dir));
	pruning.set(dir, prune);
	return prune;
}

/** Prunes in flight in this process, by worktrees folder. */
const pruning = new Map<string, Promise<PruneReport>>();

async function pruneDir(repo: string, dir: string): Promise<PruneReport> {
	const report: PruneReport = { saved: [], kept: [] };
	if (!fs.existsSync(dir)) return report;
	await releaseDeadClaims(dir, fs.readdirSync(dir), CLAIM_MARKER);
	for (const entry of fs.readdirSync(dir)) {
		if (!entry.endsWith(".json")) continue;
		if (fs.lstatSync(path.join(dir, entry)).isSymbolicLink()) continue;
		const agentId = entry.slice(0, -".json".length);
		let record: { owners?: unknown; repo?: unknown; base?: unknown; snapshot?: unknown } = {};
		try {
			record = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")) as typeof record;
		} catch {
			// Unreadable: orphaned, unless it is fresh enough to be another session's record still being created.
			if (
				Date.now() - (fs.statSync(path.join(dir, entry), { throwIfNoEntry: false })?.mtimeMs ?? 0) <
				UNREADABLE_GRACE_MS
			)
				continue;
		}
		if (ownersOf(record).some((each) => sameProcess(each.pid, each.started)) || !ID_PATTERN.test(agentId)) continue;
		// Two sessions starting together both see the orphan: only the one whose rename wins saves and removes it.
		const claimed = path.join(dir, `${entry}${claimSuffix(CLAIM_MARKER)}`);
		try {
			fs.renameSync(path.join(dir, entry), claimed);
		} catch {
			continue;
		}
		const worktree = {
			agentId,
			repo,
			path: path.join(dir, agentId),
			base: typeof record.base === "string" ? record.base : "",
			snapshot: typeof record.snapshot === "string" ? record.snapshot : undefined,
		};
		try {
			if (record.repo !== undefined && record.repo !== repo)
				throw new Error("Worktree owner record names a different repository");
			const { ref } = await finishWorktree(worktree);
			fs.rmSync(claimed, { force: true });
			report.saved.push({ agentId, ...(ref ? { ref } : {}) });
		} catch (error) {
			// Kept: its owner record goes back, so the next prune reports it again.
			fs.renameSync(claimed, path.join(dir, entry));
			report.kept.push({ agentId, error: errorMessage(error) });
		}
	}
	await quiet(git(repo, ["worktree", "prune"]));
	return report;
}

/** What a prune did, for the user: saved refs as info, kept worktrees as a warning; undefined when nothing was orphaned. */
export function describePrune(report: PruneReport): { text: string; level: "info" | "warning" } | undefined {
	const lines = [
		...(report.saved.length
			? [
					`Removed ${report.saved.length} orphaned subagent worktree(s): ${report.saved.map(({ agentId, ref }) => (ref ? `${agentId} (changes on ${ref})` : `${agentId} (no changes)`)).join(", ")}.`,
				]
			: []),
		...report.kept.map(({ agentId, error }) => `Kept orphaned subagent worktree ${agentId}: ${error}`),
	];
	return lines.length ? { text: lines.join("\n"), level: report.kept.length ? "warning" : "info" } : undefined;
}
