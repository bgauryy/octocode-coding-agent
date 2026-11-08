import { AGENT_SCRATCH_ENV, SUBAGENT_ENV, TEAM_WORKSPACE_ENV, envFlag } from "../../../../common/src/env.ts";
import { mutatedPaths } from "../shared/file-input.ts";
import { resolveToolPath } from "../shared/home.ts";
import { optionalString } from "../shared/util.ts";
import { shellPath } from "./file-access.ts";
import { bashSyntax } from "./bash-syntax.ts";
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
 * Like the read-only guard it reads `file` paths and what the shell parse shows: the paths a command names, the
 * repository a command with no file to name changes (`git -C <main> reset --hard`, `git --work-tree=<main> checkout`,
 * `tar -C <main>`), and a ref it moves, since a worktree shares every branch, tag and stash with the main checkout. A
 * write the parse cannot place is refused when it follows a `cd` the parse cannot follow, or when the command names the
 * main tree. It is not a sandbox, so a program that writes by itself (`node script.js`) is not seen.
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

/** The part of a word's source text before anything expands: `../main/$X` names the main tree whatever `$X` holds. */
const literalStart = (raw: string): string => raw.replace(/^["']/, "").split(/[$`*?[{"']/)[0] ?? "";

/** The refusal for a call that would change the main tree from an isolated child, or undefined when it may (or this is not one). */
export function isolatedTreeRefusal(
	event: { toolName: string; input: unknown },
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const main = isolatedMainTree(cwd, env);
	if (!main) return undefined;
	const input = (typeof event.input === "object" && event.input !== null ? event.input : {}) as Record<string, unknown>;
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
	const command = optionalString(input.command) ?? "";
	const effect = shellMutation(command, 0, env);
	const found = [...effect.writes, ...effect.databases, ...effect.areas, ...effect.unreadAreas].find((file) =>
		intoMain(file, true),
	);
	if (found !== undefined) return refusal(`Changing ${found} from the shell`, main);
	if (effect.refMoves.length > 0)
		return refusal(`\`${effect.refMoves[0]}\` (every worktree of this repository shares its refs)`, main);
	if (effect.afterDirectoryChange)
		return refusal(
			"A write to a relative path after a `cd` the guard cannot follow (it follows only `cd /abs/dir`, `cd ~/dir` or `cd ./dir` joined by `&&`: not a bare name, `..`, a variable, `cd -`, `||` or a loop)",
			main,
		);
	// An awk call outside its allowlist (`awkUnread`) is uncertain here too: its program or library may write the main tree.
	if (!effect.uncertain && effect.awkUnread === undefined) return undefined;
	const spelled = [main, env[TEAM_WORKSPACE_ENV]?.trim() ?? main];
	const namesMain =
		spelled.some((form) => command.includes(form)) ||
		bashSyntax(command).commands.some((part) => part.tokens.some(({ raw }) => intoMain(literalStart(raw), true)));
	return namesMain
		? refusal("A shell write whose target the guard cannot resolve, in a command naming it,", main)
		: undefined;
}
