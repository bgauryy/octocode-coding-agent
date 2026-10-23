import fs from "node:fs";
import path from "node:path";
import { projectMcpConfigPaths } from "../../../core/mcp-config-paths.ts";
import { sha256 } from "../atomic.ts";
import { projectAgentDirs, projectHookFiles, projectSkillDirs } from "../home.ts";

/** The project MCP definition files the MCP loader reads from `cwd`; each can start a stdio command. */
export function projectMcpFiles(cwd: string): string[] {
	return projectMcpConfigPaths(cwd).filter(isFile).map(realPath);
}

/** Every existing trust-gated project file, sorted: the same paths the hooks, MCP, profile and skill loaders read. */
export function projectConfigFiles(cwd: string): string[] {
	const files = [
		...projectHookFiles(cwd),
		...projectMcpConfigPaths(cwd),
		...projectAgentDirs(cwd).flatMap((dir) => listDir(dir).filter((file) => file.endsWith(".md"))),
		...projectSkillDirs(cwd).flatMap((dir) => skillFiles(dir, true, new Set())),
	];
	// Real paths: the fingerprint hashes them, and a symlinked spelling of the same project must not ask again.
	return [...new Set(files.filter(isFile).map(realPath))].sort();
}

/**
 * SHA-256 over the paths and bytes of `files`: any added, removed or edited file changes it. `as` names each file
 * by another path (a worktree's file as its parent repository's).
 */
export function fingerprint(
	files: string[],
	as: (file: string) => string = (file) => file,
	read: (file: string) => string = readForFingerprint,
): string {
	return sha256(files.map((file) => `${as(file)}\0${read(file)}`).join("\0\0"));
}

/**
 * The skill files Octocode's loader (0.x `loadSkillsFromDir`) would read from `dir`: a directory holding `SKILL.md` is one
 * skill (that file, no recursion); otherwise the root's direct `.md` files and, at any depth, subdirectories' `SKILL.md`.
 * Dot entries and `node_modules` are skipped like Octocode does. Octocode's ignore files are not applied, so this is a superset.
 */
export function skillFiles(dir: string, root: boolean, seen: Set<string>): string[] {
	const real = realPath(dir);
	if (seen.has(real)) return [];
	seen.add(real);
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const skill = path.join(dir, "SKILL.md");
	if (entries.includes("SKILL.md") && isFile(skill)) return [skill];
	return entries.flatMap((name) => {
		if (name.startsWith(".") || name === "node_modules") return [];
		const full = path.join(dir, name);
		const stat = fs.statSync(full, { throwIfNoEntry: false });
		if (stat?.isDirectory()) return skillFiles(full, false, seen);
		return root && stat?.isFile() && name.endsWith(".md") ? [full] : [];
	});
}

export function realPath(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch {
		return path.resolve(file);
	}
}

export function readText(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/** A file's text for the fingerprint; an unreadable file (permissions, a race) gets a marker, so it never hashes like an empty one. */
export function readForFingerprint(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "\0unreadable";
	}
}

export function listDir(dir: string): string[] {
	try {
		return fs.readdirSync(dir).map((name) => path.join(dir, name));
	} catch {
		return [];
	}
}

export function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}
