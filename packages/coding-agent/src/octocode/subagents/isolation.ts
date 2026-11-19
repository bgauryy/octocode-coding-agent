import type { FeatureContext } from "../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { ask } from "../ask/ask.ts";
import { confirmed } from "../ask/decode.ts";
import { confirm } from "../ask/question.ts";
import { teamWorkspace } from "../team/store/workspace.ts";
import { forgetWorktreeOpening, recordWorktreeOpening } from "../worktrees/openings.ts";
import { type WorktreeTrustRequest, worktreeTrustTitle } from "../worktrees/approval.ts";
import type { Identity } from "./process/env.ts";
import { createWorktree, finishWorktree, isolationReport, reopenWorktree, type Worktree } from "./worktree.ts";

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
	/** A resumed isolated child's saved ref and recorded worktree path: `start` recreates the worktree from them. */
	private readonly reopen: { ref: string; path: string } | undefined;
	constructor(id: string, item?: string, reopen?: { ref: string; path: string }) {
		this.id = id;
		this.item = item;
		this.reopen = reopen;
	}

	/**
	 * Creates the worktree (a resumed child's: recreates it, `reopenWorktree`) and returns the child's cwd. The worktree is
	 * its own git root: the child stays on this team.
	 */
	async start(
		ctx: Pick<FeatureContext, "cwd" | "hasUI" | "ui">,
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
		this.worktree = this.reopen
			? await reopenWorktree(ctx.cwd, this.id, this.reopen, this.item, approve)
			: await createWorktree(ctx.cwd, this.id, undefined, workingCopy, this.item, approve);
		// The parent made it for the child, so the parent is the opener (a top-level run's own id stands in for none).
		recordWorktreeOpening(this.worktree.path, { id: identity.parentId ?? identity.id, sessionId: identity.sessionId });
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
						const report = isolationReport(this.id, result);
						try {
							forgetWorktreeOpening(worktree.path);
						} catch (error) {
							return `${report}\n\nThe opening record of ${worktree.path} could not be dropped: ${errorMessage(error)}`;
						}
						return report;
					},
					(error: unknown) => isolationReport(this.id, { error: errorMessage(error) }),
				)
			: Promise.resolve("");
	}
}
