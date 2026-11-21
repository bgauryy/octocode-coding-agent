import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { claimSuffix, releaseDeadClaims } from "../shared/claims.ts";
import { gitQuiet } from "../../utils/git-run.ts";
import { getOctocodeHome } from "../../config.ts";
import { repoKey } from "../../utils/git-repository.ts";
import { sameProcessAsync } from "../shared/process.ts";
import {
	ID_PATTERN,
	legacyWorktreesDir,
	ownersOf,
	repoRoot,
	type WorktreeOutputs,
	worktreesDir,
} from "./worktree-base.ts";
import { finishWorktree } from "./worktree-finish.ts";
import { outputsReport } from "./worktree-outputs.ts";

export interface PruneReport {
	/** Orphaned worktrees removed after their changes were saved; `ref` is absent when one changed nothing, `patch` is the child's own change as a file when the ref did not take it cleanly, `outputs` the git-ignored files copied to the checkout, `item` is the backlog item its child worked on. */
	saved: Array<{ agentId: string; ref?: string; patch?: string; item?: string; outputs?: WorktreeOutputs }>;
	/** Orphaned worktrees kept because their changes could not be saved. */
	kept: Array<{ agentId: string; error: string }>;
}

/** An owner record this young that cannot be read may be mid-write by another session: leave its worktree alone. */
const UNREADABLE_GRACE_MS = 60_000;

/** An owner record being pruned is renamed `<agent>.json.pruning-<pid>-<start time>` by the session that claimed it (`shared/claims.ts`). */
const CLAIM_MARKER = ".pruning-";

/** Prunes in flight in this process, by worktrees folder. */
const pruning = new Map<string, Promise<PruneReport>>();

interface OwnerRecord {
	owners?: unknown;
	repo?: unknown;
	base?: unknown;
	snapshot?: unknown;
	item?: unknown;
}

/**
 * Removes worktrees of this repository whose owning Octocode processes (parent and subagent) are all gone, whichever of
 * its checkouts created them: the repository's shared folder, and the folder earlier versions kept for this checkout.
 * Their changes are first committed to the agent's ref; a worktree whose changes cannot be saved is kept and reported,
 * so a crash never loses an isolated subagent's work. A call while a prune of the same repository runs in this process
 * joins it: two would only contend for git's index lock (other processes are kept apart by the rename claim).
 */
export function pruneWorktrees(cwd: string, home = getOctocodeHome()): Promise<PruneReport> {
	let repo: string;
	try {
		repo = repoRoot(cwd);
	} catch {
		return Promise.resolve({ saved: [], kept: [] });
	}
	const shared = worktreesDir(repo, home);
	const running = pruning.get(shared);
	if (running) return running;
	const dirs = [...new Set([shared, legacyWorktreesDir(repo, home)])];
	const prune = pruneDirs(repo, repoKey(repo).key, dirs).finally(() => pruning.delete(shared));
	pruning.set(shared, prune);
	return prune;
}

async function pruneDirs(repo: string, key: string, dirs: string[]): Promise<PruneReport> {
	const report: PruneReport = { saved: [], kept: [] };
	for (const dir of dirs) await pruneDir(repo, key, dir, report);
	await gitQuiet(repo, ["worktree", "prune"]);
	return report;
}

/** Whether a record's recorded checkout belongs to the repository `key` names; a checkout that is gone cannot say, and the folder already is the repository's. */
const sameRepository = (recorded: unknown, key: string): boolean =>
	recorded === undefined ||
	(typeof recorded === "string" && (!fs.existsSync(recorded) || repoKey(recorded).key === key));

async function pruneDir(repo: string, key: string, dir: string, report: PruneReport): Promise<void> {
	if (!fs.existsSync(dir)) return;
	await releaseDeadClaims(dir, fs.readdirSync(dir), CLAIM_MARKER);
	for (const entry of fs.readdirSync(dir)) {
		if (!entry.endsWith(".json")) continue;
		if (fs.lstatSync(path.join(dir, entry)).isSymbolicLink()) continue;
		const agentId = entry.slice(0, -".json".length);
		let record: OwnerRecord = {};
		try {
			record = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")) as OwnerRecord;
		} catch {
			// Unreadable: orphaned, unless it is fresh enough to be another session's record still being created.
			if (
				Date.now() - (fs.statSync(path.join(dir, entry), { throwIfNoEntry: false })?.mtimeMs ?? 0) <
				UNREADABLE_GRACE_MS
			)
				continue;
		}
		if (
			(await Promise.all(ownersOf(record).map((each) => sameProcessAsync(each.pid, each.started)))).some(Boolean) ||
			!ID_PATTERN.test(agentId)
		)
			continue;
		// Two sessions starting together both see the orphan: only the one whose rename wins saves and removes it.
		const claimed = path.join(dir, `${entry}${claimSuffix(CLAIM_MARKER)}`);
		try {
			fs.renameSync(path.join(dir, entry), claimed);
		} catch {
			continue;
		}
		// Git works from this checkout: every checkout of the repository shares its worktree list and refs.
		const worktree = {
			agentId,
			repo,
			path: path.join(dir, agentId),
			base: typeof record.base === "string" ? record.base : "",
			snapshot: typeof record.snapshot === "string" ? record.snapshot : undefined,
		};
		try {
			if (!sameRepository(record.repo, key)) throw new Error("Worktree owner record names a different repository");
			const { ref, conflict, outputs } = await finishWorktree(worktree);
			fs.rmSync(claimed, { force: true });
			report.saved.push({
				agentId,
				...(ref ? { ref } : {}),
				...(conflict ? { patch: conflict.patch } : {}),
				...(outputs ? { outputs } : {}),
				...(typeof record.item === "string" ? { item: record.item } : {}),
			});
		} catch (error) {
			// Kept: its owner record goes back, so the next prune reports it again.
			fs.renameSync(claimed, path.join(dir, entry));
			report.kept.push({ agentId, error: errorMessage(error) });
		}
	}
}

/** What a prune did, for the user: saved refs as info, kept worktrees as a warning; undefined when nothing was orphaned. */
export function describePrune(report: PruneReport): { text: string; level: "info" | "warning" } | undefined {
	const lines = [
		...(report.saved.length
			? [
					`Removed ${report.saved.length} orphaned subagent worktree(s): ${report.saved.map(({ agentId, ref, patch }) => (ref ? `${agentId} (changes on ${ref}${patch ? `, own change as patch ${patch}` : ""})` : `${agentId} (no changes)`)).join(", ")}.`,
					...report.saved.flatMap(({ agentId, outputs }) => {
						const text = outputsReport(agentId, outputs).trim();
						return text ? [`${agentId}: ${text}`] : [];
					}),
				]
			: []),
		...report.kept.map(({ agentId, error }) => `Kept orphaned subagent worktree ${agentId}: ${error}`),
	];
	return lines.length ? { text: lines.join("\n"), level: report.kept.length ? "warning" : "info" } : undefined;
}
