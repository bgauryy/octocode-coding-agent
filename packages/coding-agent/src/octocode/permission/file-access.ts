import path from "node:path";
import { canonicalPath, isWithin, OCTOCODE_DIR, octocodeHome, resolveToolPath, workspaceRoot } from "../shared/home.ts";
import type { ActionClass } from "./mode.ts";
import type { BashFileTarget } from "./bash-types.ts";

/**
 * Repository paths that load code, hooks or agent instructions in later sessions (git config, Octocode, Claude Code, Codex
 * and Octocode project config, skills): a change there outlives the session, so it asks like an outside change.
 */
const RUNS_LATER_AT_ROOT = [".git", ".pi", ".claude", ".codex", ".agents", OCTOCODE_DIR];
/** Paths that run or load code at any depth (a nested repository's hooks, a package's `.husky`, a folder's `.envrc`). */
const RUNS_LATER_ANYWHERE = [".git/hooks", ".husky", ".github/workflows", ".vscode/tasks.json", ".envrc"];

export function runsLater(file: string, root: string): boolean {
	const relative = path.relative(root, file).split(path.sep).join("/");
	const rooted = RUNS_LATER_AT_ROOT.some((entry) => relative === entry || relative.startsWith(`${entry}/`));
	return (
		rooted ||
		RUNS_LATER_ANYWHERE.some((entry) => `/${relative}`.endsWith(`/${entry}`) || `/${relative}`.includes(`/${entry}/`))
	);
}

/** The refusal for a change inside Octocode's state folder (its trust store, agent database, config), in every mode. */
export function stateFolderRefusal(file: string, shown: string, tool: string): string | undefined {
	if (!isWithin(canonicalPath(file), canonicalPath(octocodeHome()))) return undefined;
	return `${shown} is in Octocode's state folder; ${tool} does not change it. Ask the user to change it themselves.`;
}

export function shellTargetAccess(
	target: BashFileTarget,
	cwd: string,
): {
	refusal?: string;
	action?: ActionClass;
	uncertain?: boolean;
	protected?: boolean;
} {
	if (!target.path || target.uncertain) return { uncertain: true };
	const file = canonicalPath(resolveToolPath(cwd, target.path));
	if (target.kind === "write") {
		const refusal = stateFolderRefusal(file, target.raw, "Bash");
		if (refusal) return { refusal };
	}
	const root = workspaceRoot(cwd);
	const inside = root !== undefined && isWithin(file, root);
	return {
		protected: target.kind === "write" && inside && runsLater(file, root),
		action:
			target.kind === "read"
				? inside
					? undefined
					: "read.outside"
				: inside && !runsLater(file, root)
					? undefined
					: "file.outside",
	};
}
