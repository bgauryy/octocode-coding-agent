import { renderInstruction } from "../prompt-template.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import chalk from "chalk";
import { canonicalizePath, resolvePath } from "../../../../common/src/paths.ts";
import { stripBom } from "../../../../common/src/text.ts";
import { CONTEXT_FILE_CANDIDATES } from "../discovery/sources.ts";
import { configDiscovery, discoveryInput } from "../discovery/service.ts";
import type { ConfigKind } from "../discovery/types.ts";
import { findGitPaths } from "../footer-data-provider.ts";
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
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${String(error)}`));
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
	return `${bytes.subarray(0, end).toString("utf8")}\n\n${renderInstruction("notices/context-file-cut.md", { path })}`;
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
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${String(error)}`));
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
	const worktreeContextFile = loadContextFileFromDir(worktreeRoot);
	return worktreeContextFile ? join(mainRepoRoot, basename(worktreeContextFile.path)) : undefined;
}

/**
 * `contextRoot` is the folder a trust grant is on (`FolderTrustView.root`): project instructions load from it down to
 * `cwd` and nothing above it is read. Without it (or when it is not an ancestor of `cwd`) the walk reaches the
 * filesystem root, as before.
 */
export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
	contextRoot?: string;
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
		.discover("context", discoveryInput({ cwd: resolvedCwd, agentDir: resolvedAgentDir, projectTrusted: false }))
		.find((item) => item.loaded);
	const globalContext = globalFile ? loadContextFileFromDir(dirname(globalFile.provenance.path)) : null;
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	const shadowedContextFile = findShadowedContextFile(resolvedCwd);
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

		if (currentDir === boundary) break;
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
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
