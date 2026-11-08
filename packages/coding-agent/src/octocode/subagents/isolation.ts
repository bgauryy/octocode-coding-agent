import type { ExtensionContext } from "../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { ask } from "../ask/ask.ts";
import { confirmed } from "../ask/decode.ts";
import { confirm } from "../ask/question.ts";
import { teamWorkspace } from "../team/store/workspace.ts";
import { type WorktreeTrustRequest, worktreeTrustTitle } from "../worktrees/approval.ts";
import type { Identity } from "./process/env.ts";
import { createWorktree, finishWorktree, isolationReport, type Worktree } from "./worktree.ts";

/** An isolated run's private worktree; `finish` commits its changes to the agent's ref and removes it, once, and returns the text for the report. */
export class Isolation {
	worktree: Worktree | undefined;
	/** The ref the child's changes were saved on, once `finish` has run; absent when it changed nothing or saving failed. */
	ref: string | undefined;
	/** The file holding the child's own change when the ref did not take it cleanly (`WorktreeResult.conflict`). */
	patch: string | undefined;

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
		signal?: AbortSignal,
	): Promise<string> {
		// The parent asks, because the worktree is created in this process: the child never prompts and never records.
		// Esc on the turn, a permission change or shutdown dismisses the question, which holds a slot while it is open.
		const approve = ctx.hasUI
			? async (request: WorktreeTrustRequest) => {
					const question = confirm("worktree-trust", worktreeTrustTitle(request));
					const [reply] = await ask(ctx, [question], signal ? { signal } : {});
					signal?.throwIfAborted();
					return confirmed(question, reply);
				}
			: undefined;
		this.worktree = await createWorktree(ctx.cwd, this.id, undefined, workingCopy, this.item, approve);
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
						this.patch = result.conflict?.patch;
						return isolationReport(this.id, result);
					},
					(error: unknown) => isolationReport(this.id, { error: errorMessage(error) }),
				)
			: Promise.resolve("");
	}
}
