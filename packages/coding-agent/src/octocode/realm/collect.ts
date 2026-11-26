import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { CommandContext } from "../../core/features/index.ts";
import { worktreesDir } from "../worktree-paths/own-worktree.ts";
import { canonical } from "../worktrees/repo.ts";
import { worktreeStatuses, type WorktreeStatus } from "../worktrees/status.ts";
import { buildPlaces, type PlaceFolder, type PlaceKind, type PlaceSession, type PlaceView } from "./model.ts";
import type { SessionSource } from "./sessions.ts";

/** What the place view reads besides git: the team's live agents and the saved sessions. */
export interface PlaceDependencies {
	/** Live agents of this repository's team, every worktree included. */
	members: () => Member[];
	sessions: SessionSource;
}

function folderOf(status: WorktreeStatus, isolatedDir: string): PlaceFolder {
	const { entry } = status;
	const gone = entry.prunable || !fs.existsSync(entry.path);
	const kind: PlaceKind = status.main
		? "checkout"
		: status.name
			? "worktree"
			: path.dirname(canonical(entry.path)) === isolatedDir
				? "isolated"
				: "linked";
	const readable = !gone && !status.error;
	return {
		path: entry.path,
		kind,
		...(entry.branch ? { branch: entry.branch } : {}),
		...(readable ? { changed: status.dirty + status.untracked, unmerged: status.unmerged } : {}),
		...(status.error ? { error: status.error } : {}),
		gone,
	};
}

/**
 * The repository's places with their agents and sessions. Rejects when the session's folder is not in a git repository;
 * when only the session list fails, the places still come back, with `sessionsProblem` saying why they show none.
 */
export async function collectPlaces(
	ctx: CommandContext,
	deps: PlaceDependencies,
): Promise<{ view: PlaceView; sessionsProblem?: string }> {
	const { main, statuses } = await worktreeStatuses(ctx.cwd);
	const isolatedDir = canonical(worktreesDir(ctx.cwd));
	const folders = statuses.map((status) => folderOf(status, isolatedDir));
	let sessions: PlaceSession[] = [];
	let sessionsProblem: string | undefined;
	try {
		sessions = await deps.sessions(
			folders.filter((folder) => !folder.gone).map((folder) => folder.path),
			ctx,
		);
	} catch (error) {
		sessionsProblem = errorMessage(error);
	}
	const view = buildPlaces({ main, folders, members: deps.members(), sessions, here: ctx.cwd });
	return { view, ...(sessionsProblem ? { sessionsProblem } : {}) };
}
