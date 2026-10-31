import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { canonicalizePath, resolvePath } from "../../../../common/src/paths.ts";
import { stripBom } from "../../../../common/src/text.ts";
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
	return `${bytes.subarray(0, end).toString("utf8")}\n\n[Context file truncated at 64 KiB; read ${path} for the rest.]`;
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
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

export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
}): Array<{ path: string; content: string }> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	const globalContext = loadContextFileFromDir(resolvedAgentDir);
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

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

export function discoverSystemPromptFile(roots: ResourceRoots, settingsManager: SettingsManager): string | undefined {
	const projectPath = join(roots.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
	if (settingsManager.isProjectTrusted() && existsSync(projectPath)) {
		return projectPath;
	}

	const globalPath = join(roots.agentDir, "SYSTEM.md");
	if (existsSync(globalPath)) {
		return globalPath;
	}

	return undefined;
}

export function discoverAppendSystemPromptFile(
	roots: ResourceRoots,
	settingsManager: SettingsManager,
): string | undefined {
	const projectPath = join(roots.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
	if (settingsManager.isProjectTrusted() && existsSync(projectPath)) {
		return projectPath;
	}

	const globalPath = join(roots.agentDir, "APPEND_SYSTEM.md");
	if (existsSync(globalPath)) {
		return globalPath;
	}

	return undefined;
}
