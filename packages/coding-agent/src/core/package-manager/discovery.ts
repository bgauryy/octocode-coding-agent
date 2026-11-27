import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ignore from "ignore";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { gitMarkerDir } from "../../utils/git-marker.ts";
import { addIgnoreRules, type IgnoreMatcher, toPosixPath } from "../../utils/ignore.ts";

export function getPackageTempFolder(agentDir: string): string {
	const tempFolder = join(agentDir, "tmp", "packages");
	mkdirSync(tempFolder, { recursive: true, mode: 0o700 });
	chmodSync(tempFolder, 0o700);
	return tempFolder;
}

export interface DirectoryEntry {
	name: string;
	fullPath: string;
	/** Path relative to the ignore root, with forward slashes. */
	relPath: string;
	isDir: boolean;
	isFile: boolean;
}

/**
 * The visible entries of `dir`: hidden names (and `node_modules` unless `skipNodeModules` is false) are left out,
 * symbolic links report their target's kind, and broken links are dropped. Throws when `dir` cannot be read.
 */
export function readDirectoryEntries(dir: string, root: string, skipNodeModules = true): DirectoryEntry[] {
	const result: DirectoryEntry[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		if (skipNodeModules && entry.name === "node_modules") continue;
		const fullPath = join(dir, entry.name);
		let isDir = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				const stats = statSync(fullPath);
				isDir = stats.isDirectory();
				isFile = stats.isFile();
			} catch {
				continue;
			}
		}
		result.push({ name: entry.name, fullPath, relPath: toPosixPath(relative(root, fullPath)), isDir, isFile });
	}
	return result;
}

/** Whether the ignore rules exclude `entry`; directories are matched with a trailing slash. */
export function isIgnored(ig: IgnoreMatcher, entry: DirectoryEntry): boolean {
	return ig.ignores(entry.isDir ? `${entry.relPath}/` : entry.relPath);
}

export function collectFiles(
	dir: string,
	filePattern: RegExp,
	skipNodeModules = true,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		for (const entry of readDirectoryEntries(dir, root, skipNodeModules)) {
			if (isIgnored(ig, entry)) continue;
			if (entry.isDir) {
				files.push(...collectFiles(entry.fullPath, filePattern, skipNodeModules, ig, root));
			} else if (entry.isFile && filePattern.test(entry.name)) {
				files.push(entry.fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return files;
}

type SkillDiscoveryMode = "octocode" | "agents";

/**
 * Skill entries under `dir`: a directory with a `SKILL.md` is one skill and is not searched further; otherwise its
 * Markdown files (top level in `octocode` mode, nested in `agents` mode) and its subdirectories are searched.
 */
export function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const dirEntries = readDirectoryEntries(dir, root);
		const skillFile = dirEntries.find(
			(entry) => entry.name === "SKILL.md" && entry.isFile && !ig.ignores(entry.relPath),
		);
		if (skillFile) return [skillFile.fullPath];

		const markdownHere = (mode === "octocode" && dir === root) || (mode === "agents" && dir !== root);
		for (const entry of dirEntries) {
			if (
				entry.isFile &&
				markdownHere &&
				entry.name.endsWith(".md") &&
				// A README documents its folder; it is not a skill candidate.
				entry.name.toLowerCase() !== "readme.md" &&
				!ig.ignores(entry.relPath)
			) {
				entries.push(entry.fullPath);
				continue;
			}
			if (!entry.isDir || isIgnored(ig, entry)) continue;
			entries.push(...collectSkillEntries(entry.fullPath, mode, ig, root));
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

/**
 * `.octocode/skills` of the directories above `startDir` up to its repository root, nearest first. The working
 * directory's own folder is the project skills folder. Outside a repository there are none, so a home `.octocode`
 * is never read as a project.
 */
export function collectAncestorProjectSkillDirs(startDir: string): string[] {
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = gitMarkerDir(resolvedStartDir);
	const skillDirs: string[] = [];
	if (!gitRepoRoot) return skillDirs;
	let dir = resolvedStartDir;
	while (dir !== gitRepoRoot) {
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
		skillDirs.push(join(dir, CONFIG_DIR_NAME, "skills"));
	}
	return skillDirs;
}
