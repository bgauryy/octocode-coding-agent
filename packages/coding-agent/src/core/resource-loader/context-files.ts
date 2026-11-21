import { renderPrompt } from "../prompt-template.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { cliStyle } from "../../utils/cli-style.ts";
import { canonicalizePath, resolvePath } from "@octocodeai/octocode-common/paths";
import { stripBom } from "@octocodeai/octocode-common/text";
import { CONTEXT_FILE_CANDIDATES } from "../discovery/sources.ts";
import type { Toggles } from "../extensibility/toggles.ts";
import { configDiscovery, discoveryInput } from "../discovery/service.ts";
import type { ConfigKind } from "../discovery/types.ts";
import { findGitPaths } from "../footer-data-provider.ts";
import { gitMarkerDir } from "../../utils/git-marker.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { ResourceRoots } from "./source-info.ts";

export function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return stripBom(readFileSync(input, "utf-8"));
		} catch (error) {
			process.stderr.write(
				`${cliStyle.warn(`Warning: Could not read ${description} file ${input}: ${String(error)}`)}\n`,
			);
			return input;
		}
	}

	return input;
}

/** Each project context file enters every request whole, so an oversized or hostile one is cut here. */
const CONTEXT_FILE_MAX_BYTES = 64 * 1024;

function capContextFile(path: string, content: string): string {
	const bytes = Buffer.from(content, "utf8");
	if (bytes.length <= CONTEXT_FILE_MAX_BYTES) return content;
	let end = CONTEXT_FILE_MAX_BYTES;
	// Back up to a character boundary: UTF-8 continuation bytes are 0b10xxxxxx.
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}\n\n${renderPrompt("notices/context-file-cut.md", { path })}`;
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	for (const filename of CONTEXT_FILE_CANDIDATES) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				if (!statSync(filePath).isFile()) {
					continue;
				}
				return {
					path: filePath,
					content: capContextFile(filePath, stripBom(readFileSync(filePath, "utf-8"))),
				};
			} catch (error) {
				process.stderr.write(`${cliStyle.warn(`Warning: Could not read ${filePath}: ${String(error)}`)}\n`);
			}
		}
	}
	return null;
}

/**
 * The main repo's context file that a nested linked worktree's own copy shadows: both
 * occupy the same logical repository scope, so loading both applies that context twice. Returns
 * undefined when nothing is shadowed, leaving normal ancestor inheritance alone.
 *
 * Returned canonicalized (realpath), because `git worktree add` writes the `.git`
 * file's `gitdir:` target in realpath form while cwd may still be symlinked
 * (macOS `/tmp` -> `/private/tmp`).
 */
function findShadowedContextFile(cwd: string): string | undefined {
	const nested = nestedWorktree(cwd);
	if (!nested) return undefined;
	const worktreeContextFile = loadContextFileFromDir(nested.worktreeRoot);
	return worktreeContextFile ? join(nested.mainRepoRoot, basename(worktreeContextFile.path)) : undefined;
}

/** A linked worktree inside its own main repository: both roots, canonicalized. */
function nestedWorktree(cwd: string): { worktreeRoot: string; mainRepoRoot: string } | undefined {
	const gitPaths = findGitPaths(cwd);
	if (!gitPaths) return undefined;
	const commonGitDir = canonicalizePath(gitPaths.commonGitDir);
	const worktreeRoot = canonicalizePath(gitPaths.repoDir);
	const mainRepoRoot = dirname(commonGitDir);
	// False for an ordinary repo, where the two are the same dir, and for a sibling
	// worktree (`git worktree add ../feat`), whose main repo is not an ancestor.
	if (!worktreeRoot.startsWith(`${mainRepoRoot}${sep}`)) return undefined;
	// dirname of the common git dir is the main worktree root only when that dir is
	// itself checked out from the same repo. In a bare layout (`proj/.bare` +
	// `proj/main`) it is just the directory holding `.bare`, which tracks nothing; a
	// submodule's gitdir has no `commondir`, so it lands under `.git/modules`.
	if (canonicalizePath(join(mainRepoRoot, ".git")) !== commonGitDir) return undefined;
	return { worktreeRoot, mainRepoRoot };
}

/**
 * Whether the project walk ends at `dir`: it is the repository root of `cwd` (the nearest folder with a `.git`, or the
 * main repository's root for a linked worktree checked out inside it, which shares that scope) and a parent repository
 * lies above it. That repository is another project, so its instructions never load here; plain folders above a
 * repository still do.
 */
function parentRepositoryTest(cwd: string): (dir: string) => boolean {
	const mainRepoRoot = nestedWorktree(cwd)?.mainRepoRoot;
	const root = gitMarkerDir(cwd);
	const isRoot = (dir: string) => (mainRepoRoot ? canonicalizePath(dir) === mainRepoRoot : dir === root);
	return (dir) => isRoot(dir) && dirname(dir) !== dir && gitMarkerDir(dirname(dir)) !== undefined;
}

/**
 * Project instructions load from `cwd` upward, but never past its repository root (nearest `.git`) into a parent
 * repository, such as the superproject of a submodule or a repository holding this one in a subfolder. `contextRoot` is
 * the folder a trust grant is on (`FolderTrustView.root`): nothing above it is read either. Otherwise (or when the grant
 * is not an ancestor of `cwd`) the walk reaches the filesystem root.
 */
export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
	contextRoot?: string;
	/** With these, a trusted workspace also gets Claude Code's auto memory when `harness:claude:memory` is on. */
	projectTrusted?: boolean;
	toggles?: Toggles;
	/** The user home and environment discovery reads; default: the process's. */
	home?: string;
	env?: NodeJS.ProcessEnv;
}): Array<{ path: string; content: string }> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedRoot = options.contextRoot === undefined ? undefined : resolvePath(options.contextRoot);
	const boundary =
		resolvedRoot !== undefined && (resolvedCwd === resolvedRoot || resolvedCwd.startsWith(`${resolvedRoot}${sep}`))
			? resolvedRoot
			: undefined;
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	// The global file: Octocode's, else Pi's (`~/.pi/agent`), as discovery ranks them.
	const globalFile = configDiscovery
		.discover(
			"context",
			discoveryInput({
				cwd: resolvedCwd,
				agentDir: resolvedAgentDir,
				projectTrusted: false,
				...(options.toggles ? { toggles: options.toggles } : {}),
			}),
		)
		.find((item) => item.loaded);
	const globalContext = globalFile ? loadContextFileFromDir(dirname(globalFile.provenance.path)) : null;
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	const shadowedContextFile = findShadowedContextFile(resolvedCwd);
	const belowParentRepository = parentRepositoryTest(resolvedCwd);
	let currentDir = resolvedCwd;

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		// Compare the directory's real path, not the file's: a worktree AGENTS.md that
		// symlinks to the main repo's file resolves to the shadowed path itself.
		const isShadowed =
			shadowedContextFile !== undefined &&
			contextFile !== null &&
			join(canonicalizePath(currentDir), basename(contextFile.path)) === shadowedContextFile;
		if (contextFile && !isShadowed && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		if (currentDir === boundary || belowParentRepository(currentDir)) break;
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	const memory = configDiscovery
		.discover(
			"memory",
			discoveryInput({
				cwd: resolvedCwd,
				agentDir: resolvedAgentDir,
				projectTrusted: options.projectTrusted ?? false,
				toggles: options.toggles,
				home: options.home,
				env: options.env,
			}),
		)
		.find((item) => item.loaded);
	if (memory) contextFiles.push(claudeMemoryEntry(memory.provenance.path));

	return contextFiles;
}

/** Folders holding third-party or version-control files: their instruction files are not the user's project context. */
const NESTED_CONTEXT_SKIPPED_DIRS = new Set(["node_modules", "vendor", ".git"]);

/**
 * The instruction files of the folders between `file` and `cwd`, below `cwd` only (cwd and its ancestors are already
 * project context), outermost first, one per folder by the same candidates and 64 KB cap. Empty for a file outside cwd
 * or under a dependency or version-control folder (`NESTED_CONTEXT_SKIPPED_DIRS`).
 */
export function nestedContextFiles(file: string, cwd: string): Array<{ path: string; content: string }> {
	const root = canonicalizePath(resolvePath(cwd));
	const start = dirname(canonicalizePath(resolvePath(file)));
	if (!start.startsWith(`${root}${sep}`)) return [];
	if (
		start
			.slice(root.length + 1)
			.split(sep)
			.some((part) => NESTED_CONTEXT_SKIPPED_DIRS.has(part))
	)
		return [];
	const found: Array<{ path: string; content: string }> = [];
	for (let dir = start; dir.startsWith(`${root}${sep}`); dir = dirname(dir)) {
		const contextFile = loadContextFileFromDir(dir);
		if (contextFile) found.unshift(contextFile);
	}
	return found;
}

/** Claude Code reads the first 200 lines or 25 KB of `MEMORY.md` at start; the same here. */
const MEMORY_MAX_LINES = 200;
const MEMORY_MAX_BYTES = 25 * 1024;

/** Claude Code's notes for this project, labeled as such: read-only, and below AGENTS.md and Octocode's memories. */
function claudeMemoryEntry(path: string): { path: string; content: string } {
	const whole = stripBom(readFileSync(path, "utf-8"));
	const lines = whole.split("\n").slice(0, MEMORY_MAX_LINES).join("\n");
	const bytes = Buffer.from(lines, "utf8");
	let end = Math.min(bytes.length, MEMORY_MAX_BYTES);
	while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
	const body = bytes.subarray(0, end).toString("utf8");
	// The header says when lines were left out, and where they are: a silent cut reads as the whole file.
	const header = renderPrompt("notices/claude-memory.md", {
		path,
		dir: dirname(path),
		cut: body.trimEnd().length < whole.trimEnd().length,
		lines: MEMORY_MAX_LINES,
		kb: MEMORY_MAX_BYTES / 1024,
	}).trimEnd();
	return { path, content: `${header}\n\n${body}` };
}

/** The highest-ranked `SYSTEM.md` or `APPEND_SYSTEM.md`: Octocode's project then global file, then Pi's. */
function discoverPromptFile(
	kind: Extract<ConfigKind, "systemPrompt" | "appendSystemPrompt">,
	roots: ResourceRoots,
	settingsManager: SettingsManager,
): string | undefined {
	const input = discoveryInput({
		cwd: roots.cwd,
		agentDir: roots.agentDir,
		projectTrusted: settingsManager.isProjectTrusted(),
		toggles: settingsManager.getToggles(),
	});
	return configDiscovery.discover(kind, input).find((item) => item.loaded)?.provenance.path;
}

export function discoverSystemPromptFile(roots: ResourceRoots, settingsManager: SettingsManager): string | undefined {
	return discoverPromptFile("systemPrompt", roots, settingsManager);
}

export function discoverAppendSystemPromptFile(
	roots: ResourceRoots,
	settingsManager: SettingsManager,
): string | undefined {
	return discoverPromptFile("appendSystemPrompt", roots, settingsManager);
}
