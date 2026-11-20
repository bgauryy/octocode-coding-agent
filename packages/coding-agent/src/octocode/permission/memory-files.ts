import os from "node:os";
import path from "node:path";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { isWithin } from "@octocodeai/octocode-common/paths";
import { CONFIG_DIR_NAME, getOctocodeHome } from "../../config.ts";
import { TEST_GUARD_FILE_ENV, TEST_PROTECTED_HOMES_ENV } from "../../storage/state-paths.ts";
import { workspaceDataRoot } from "../../storage/workspace.ts";
import { repoKey, workspaceGit } from "../../utils/git-repository.ts";
import { workspaceOctocodeDir } from "../shared/home.ts";

/**
 * Where each curated memory file lives: one global file, and one per repository shared by its worktrees. It sits in the
 * permission layer, beside the refusal below, because the file tool, the shell write checks and the `memory` domain
 * that writes the files all read it, and each of them may import `permission/` (`shared/` may not reach the host).
 */

export type MemoryFileScope = "global" | "workspace";

export interface MemoryFileRef {
	scope: MemoryFileScope;
	/** The `MEMORY.md` itself. */
	path: string;
	/** The folder the file belongs to: the Octocode home for global, the main checkout (or workspace data root) else. */
	root: string;
}

const MEMORY_FILE_NAME = "MEMORY.md";
/** `<root>/.octocode/octocodecode`: the workspace file's folder, which ignores itself in git. */
const workspaceMemoryDir = (root: string): string => path.join(workspaceOctocodeDir(root), "octocodecode");

/** `getOctocodeHome()/MEMORY.md` (`OCTOCODE_HOME` moves it). Under a test run the real home's file throws. */
export function globalMemoryFile(env: NodeJS.ProcessEnv = process.env): MemoryFileRef {
	const root = getOctocodeHome(env);
	const file = path.join(root, MEMORY_FILE_NAME);
	if (underTest(env) && protectedHomes(env).some((home) => isWithin(file, path.join(home, CONFIG_DIR_NAME))))
		throw new Error(`A test resolved the real global memory file (${file}); isolate HOME and OCTOCODE_HOME.`);
	return { scope: "global", path: file, root };
}

/**
 * The repository's main checkout: a linked worktree (an isolated child's too) resolves through the git common dir, so
 * every worktree shares one file. A repository whose common dir is not `<checkout>/.git` (a bare repository, a
 * submodule) keeps the current checkout. Outside git it is the workspace data root.
 */
export function memoryWorkspaceRoot(cwd: string): string {
	const git = workspaceGit(cwd);
	if (!git) return workspaceDataRoot(cwd);
	return path.basename(git.commonDir) === ".git" ? path.dirname(git.commonDir) : repoKey(cwd).root;
}

/** `<main checkout>/.octocode/octocodecode/MEMORY.md` of `cwd`'s repository. */
export function workspaceMemoryFile(cwd: string): MemoryFileRef {
	const root = memoryWorkspaceRoot(cwd);
	return { scope: "workspace", path: path.join(workspaceMemoryDir(root), MEMORY_FILE_NAME), root };
}

/**
 * Whether a test run must leave `file` alone: a workspace file inside the account's real home (this checkout, say) is
 * read as absent and refused for writes, so no test reads or changes the user's notes.
 */
export function protectedFromTests(file: MemoryFileRef, env: NodeJS.ProcessEnv = process.env): boolean {
	return underTest(env) && protectedHomes(env).some((home) => isWithin(file.path, home));
}

/**
 * The curated MEMORY.md files above belong to the `memory` tool, which keeps their sections, caps and
 * secret checks and writes them under a revision check. Every session loads them into its prompt, so a change made around
 * that tool would steer later sessions unchecked. Refused here: the global file, the repository's own (in a linked
 * worktree, the main checkout's), and any other repository's file at the same place. Compared lower-cased, as macOS and
 * Windows open them; on a case-sensitive filesystem the extra match only refuses a file nothing loads. The file tool
 * and the permission layer (a shell write or delete) both refuse with it.
 */
export function memoryFileRefusal(
	file: string,
	shown: string,
	tool: string,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (path.basename(file).toLowerCase() !== "memory.md") return undefined;
	const real = canonicalPath(file).toLowerCase();
	const workspace = workspaceMemoryFile(cwd);
	// `.octocode/octocodecode/memory.md`: where every repository keeps its file.
	const place = path.relative(workspace.root, workspace.path).toLowerCase();
	const known = [globalMemoryFile(env).path, workspace.path].map((each) => canonicalPath(each).toLowerCase());
	if (!known.includes(real) && !real.endsWith(`${path.sep}${place}`)) return undefined;
	return envFlag(env, SUBAGENT_ENV)
		? `${shown} is a curated memory file; ${tool} does not change it, and a subagent's memory is read-only: put the note in your report's \`Noticed:\` line instead.`
		: `${shown} is a curated memory file; ${tool} does not change it. Save, update or delete notes with the \`memory\` tool.`;
}

/** The run's test markers (`vitest.tmp.global.ts`), as the agent database guard reads them (`storage/state-paths.ts`). */
const pick = (env: NodeJS.ProcessEnv, name: string): string | undefined => env[name] || process.env[name] || undefined;
const underTest = (env: NodeJS.ProcessEnv): boolean =>
	Boolean(pick(env, TEST_GUARD_FILE_ENV) || pick(env, TEST_PROTECTED_HOMES_ENV));

/** The account's home from the user database (a test's `HOME` does not move it), plus the homes the run protects. */
function protectedHomes(env: NodeJS.ProcessEnv): string[] {
	const homes: string[] = [];
	try {
		homes.push(os.userInfo().homedir);
	} catch {
		// No user database entry: only the run's own list applies.
	}
	for (const value of [env[TEST_PROTECTED_HOMES_ENV], process.env[TEST_PROTECTED_HOMES_ENV]])
		for (const home of value?.split(path.delimiter) ?? []) if (home.trim()) homes.push(path.resolve(home.trim()));
	return homes;
}
