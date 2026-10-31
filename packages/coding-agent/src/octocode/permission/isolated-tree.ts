import { AGENT_SCRATCH_ENV, SUBAGENT_ENV, TEAM_WORKSPACE_ENV, envFlag } from "../../../../common/src/env.ts";
import { mutatedPaths } from "../shared/file-input.ts";
import { resolveToolPath } from "../shared/home.ts";
import { optionalString } from "../shared/util.ts";
import { shellPath } from "./file-access.ts";
import { SHELL_TOOLS } from "./shell.ts";
import { shellMutation } from "./shell/mutation.ts";
import { canonicalPath, isWithin, workspaceRoot } from "../shared/home/repo.ts";

/**
 * The containment half of `isolate: true`: the child works in a private worktree and its changes land on a saved ref,
 * so a write into the parent's main tree would bypass the review and the merge. Such a write is `file.outside` for the
 * child, which `full` mode allows; this refuses it in every mode. The parent hands only an isolated child the main
 * tree's root (`OCTOCODE_TEAM_WORKSPACE`, `subagents/tool.ts` `Isolation`), so a child whose own root is that tree is not
 * isolated and is left alone. The child's scratch folder lives in the main tree on purpose and stays writable. The
 * user's way to land the changes is `/agents merge <name>`.
 *
 * Like the read-only guard it reads `file` paths and the shell command's parsed writes; it is not a sandbox, so a
 * program that writes by itself (`node script.js`) is not seen.
 */

/** The main tree an isolated subagent must not write, or undefined when this process is not an isolated subagent. */
export function isolatedMainTree(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const main = env[TEAM_WORKSPACE_ENV]?.trim();
	if (!envFlag(env, SUBAGENT_ENV) || !main) return undefined;
	const own = workspaceRoot(cwd);
	return own !== undefined && canonicalPath(own) === canonicalPath(main) ? undefined : canonicalPath(main);
}

const refusal = (what: string, main: string): string =>
	`${what} is refused: this subagent is isolated (isolate: true) and may not change the main tree (${main}). ` +
	"Change files in your own worktree; the user merges them with `/agents merge`.";

/** The refusal for a call that would change the main tree from an isolated child, or undefined when it may (or this is not one). */
export function isolatedTreeRefusal(
	event: { toolName: string; input: unknown },
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const main = isolatedMainTree(cwd, env);
	if (!main) return undefined;
	const input = (typeof event.input === "object" && event.input !== null ? event.input : {}) as Record<string, unknown>;
	// Adapter-specific launch payloads and inspection may execute against arbitrary paths.
	if (event.toolName === "graphBuild")
		return "Graph snapshot creation is refused in this role; use graphQuery on an existing snapshot.";
	if (event.toolName === "debug" && input.action !== "terminate")
		return refusal("Debugging (adapter paths and effects cannot be confined to this worktree)", main);
	const scratch = env[AGENT_SCRATCH_ENV];
	const intoMain = (file: string, fromShell = false): boolean => {
		const target = canonicalPath(fromShell ? shellPath(cwd, file) : resolveToolPath(cwd, file));
		return isWithin(target, main) && !(scratch && isWithin(target, canonicalPath(scratch)));
	};
	if (event.toolName === "file" || event.toolName === "edit" || event.toolName === "write") {
		const found = mutatedPaths(event.toolName, input).find((file) => intoMain(file));
		return found === undefined ? undefined : refusal(`Changing ${found}`, main);
	}
	if (!SHELL_TOOLS.has(event.toolName)) return undefined;
	const found = shellMutation(optionalString(input.command) ?? "").writes.find((file) => intoMain(file, true));
	return found === undefined ? undefined : refusal(`Changing ${found} from the shell`, main);
}
