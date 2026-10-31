import { worktreeNameProblem } from "../../octocode/worktrees/name.ts";
import type { FlagSpec } from "./flags.ts";

/** `--worktree <name>`: see `cli/worktree-startup.ts`, which acts on it before settings and sessions load. */
export const WORKTREE_FLAG: FlagSpec = {
	name: "--worktree",
	kind: "value",
	arg: "<name>",
	completion: "text",
	help: [
		"Start in git worktree <name>: created or reused at .octocode/worktrees/<name> on branch worktree-<name>,",
		"with untracked files matching .worktreeinclude copied into a new one",
	],
	apply: (a, v) => {
		const problem = worktreeNameProblem(v ?? "");
		if (!problem) a.worktree = v;
		return problem;
	},
};
