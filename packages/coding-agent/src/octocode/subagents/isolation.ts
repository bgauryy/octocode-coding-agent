import type { ExtensionContext } from "../../core/extensions/index.ts";
import { errorMessage } from "../../utils/guards.ts";
import { teamWorkspace } from "../team/store/workspace.ts";
import { projectTrustNow } from "../shared/trust.ts";
import type { Identity } from "./process/env.ts";
import { createWorktree, finishWorktree, isolationReport, type Worktree } from "./worktree.ts";

/** An isolated run's private worktree; `finish` commits its changes to the agent's ref and removes it, once, and returns the text for the report. */
export class Isolation {
	worktree: Worktree | undefined;

	private readonly id: string;
	constructor(id: string) {
		this.id = id;
	}

	/** Creates the worktree and returns the child's cwd. The worktree is its own git root: the child stays on this team. */
	async start(
		ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
		identity: Identity,
		workingCopy = false,
	): Promise<string> {
		this.worktree = await createWorktree(ctx.cwd, this.id, undefined, workingCopy);
		identity.isolation = { path: this.worktree.path, repo: this.worktree.repo, cwd: this.worktree.cwd };
		identity.workspace = teamWorkspace(ctx.cwd);
		// The worktree is a different root, so no stored decision matches it: hand down only a decision this session made.
		if (projectTrustNow(ctx) === true) identity.trustRoot = identity.workspace;
		return this.worktree.cwd;
	}

	finish(): Promise<string> {
		const worktree = this.worktree;
		return worktree
			? finishWorktree(worktree).then(
					(result) => isolationReport(this.id, result),
					(error: unknown) => isolationReport(this.id, { error: errorMessage(error) }),
				)
			: Promise.resolve("");
	}
}
