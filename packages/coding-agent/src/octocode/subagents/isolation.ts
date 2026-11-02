import type { ExtensionContext } from "../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { teamWorkspace } from "../team/store/workspace.ts";
import { type WorktreeTrustRequest, worktreeTrustTitle } from "../worktrees/approval.ts";
import type { Identity } from "./process/env.ts";
import { createWorktree, finishWorktree, isolationReport, type Worktree } from "./worktree.ts";

/** An isolated run's private worktree; `finish` commits its changes to the agent's ref and removes it, once, and returns the text for the report. */
export class Isolation {
	worktree: Worktree | undefined;
	/** The ref the child's changes were saved on, once `finish` has run; absent when it changed nothing or saving failed. */
	ref: string | undefined;

	private readonly id: string;
	/** The backlog item the child works on, kept with the worktree so a later prune can link what it saves. */
	private readonly item: string | undefined;
	constructor(id: string, item?: string) {
		this.id = id;
		this.item = item;
	}

	/** Creates the worktree and returns the child's cwd. The worktree is its own git root: the child stays on this team. */
	async start(
		ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "ui">,
		identity: Identity,
		workingCopy = false,
	): Promise<string> {
		// The parent asks, because the worktree is created in this process: the child never prompts and never records.
		const ask = ctx.hasUI
			? (request: WorktreeTrustRequest) => ctx.ui.confirm(worktreeTrustTitle(request), "")
			: undefined;
		this.worktree = await createWorktree(ctx.cwd, this.id, undefined, workingCopy, this.item, ask);
		identity.isolation = { path: this.worktree.path, repo: this.worktree.repo, cwd: this.worktree.cwd };
		identity.workspace = teamWorkspace(ctx.cwd);
		return this.worktree.cwd;
	}

	finish(): Promise<string> {
		const worktree = this.worktree;
		return worktree
			? finishWorktree(worktree).then(
					(result) => {
						this.ref = result.ref;
						return isolationReport(this.id, result);
					},
					(error: unknown) => isolationReport(this.id, { error: errorMessage(error) }),
				)
			: Promise.resolve("");
	}
}
