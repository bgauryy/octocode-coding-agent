/**
 * Git worktree isolation for implementer subagents, adapted from the native host's worker worktrees: each isolated
 * subagent works in a detached worktree under `<Octocode home>/worktrees/<repo-hash>/<agent-id>` (one folder for every
 * checkout of a repository); on finish its changes are committed to `refs/octocode/<agent-id>` and the worktree is
 * removed; when saving fails the worktree is kept so nothing is lost. Merging stays manual (`/agents merge`). The
 * repository's hooks never run. Ignored files (`node_modules`, builds) are not in the worktree.
 *
 * The code lives in `worktree-base.ts` (paths, owner records), `-create`, `-finish`, `-merge` and `-prune`; this file is
 * the one import path for callers.
 */
export { type Worktree, recordWorktreePid, worktreesDir } from "./worktree-base.ts";
export { createWorktree } from "./worktree-create.ts";
export { finishWorktree, isolationReport } from "./worktree-finish.ts";
export { discardAgent, mergeAgent, pendingRefs, reservedChanges, savedChanges } from "./worktree-merge.ts";
export { describePrune, pruneWorktrees } from "./worktree-prune.ts";
