import fs from "node:fs";
import path from "node:path";
import { isUnderPath } from "@octocodeai/octocode-common/paths";
import type { SandboxPolicy } from "./policy.ts";

/**
 * How many folders `**` descends below where it starts. The sandbox library's own scan for nested repositories stops at
 * the same depth, so a repository nested deeper keeps its hooks and config writable on Linux.
 */
export const ANY_DEPTH_LIMIT = 3;

/** Folders `**` does not enter: installed packages (the library's scan skips them too) and git's own folders. */
const NOT_ENTERED = new Set(["node_modules", ".git"]);

const WILDCARD = /[*?[\]{}]/;

type Use = "allow" | "deny";

/** A `*` segment as a pattern: `*` stands for any run of characters but the separator; nothing else is special. */
function segmentPattern(segment: string, pattern: string): RegExp {
	if (/[?[\]{}]/.test(segment))
		throw new Error(`The Linux command sandbox takes \`*\` and \`**\` in a path only, not ${pattern}.`);
	const source = segment
		.split("*")
		.map((part) => part.replace(/[.+^$()|\\]/g, "\\$&"))
		.join("[^/]*");
	return new RegExp(`^${source}$`);
}

function entries(dir: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		// A folder that is not there, or a file where the pattern needs a folder, matches nothing.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return [];
		throw error;
	}
}

/** Whether `file` is a folder, links followed. */
function isFolder(file: string): boolean {
	try {
		return fs.statSync(file).isDirectory();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** The folders below `dir`, up to `depth` levels down, without following links or entering `NOT_ENTERED`. */
function foldersBelow(dir: string, depth: number, skip: (folder: string) => boolean): string[] {
	if (depth === 0) return [];
	return entries(dir).flatMap((entry) => {
		const folder = path.join(dir, entry.name);
		if (!entry.isDirectory() || NOT_ENTERED.has(entry.name) || skip(folder)) return [];
		return [folder, ...foldersBelow(folder, depth - 1, skip)];
	});
}

interface Walk {
	use: Use;
	pattern: string;
	skip: (folder: string) => boolean;
}

/**
 * The paths `rest` names below `dir`. A literal tail after `**` counts only where its first name exists (as a folder
 * when more follows), so a deny of `**\/.git/hooks` names the repositories there are, and the library makes no `.git`
 * mount point in every folder. A deny whose tail follows a `*` match keeps it even before it exists: the library covers
 * a missing deny with a mount point. A match with more segments after it must be a folder. An allow names only what
 * exists, as the library ignores the rest.
 */
function walk(dir: string, rest: string[], walkOpts: Walk, afterAnyDepth: boolean): string[] {
	const [segment, ...after] = rest;
	if (segment === undefined) return walkOpts.use === "allow" && !fs.existsSync(dir) ? [] : [dir];
	if (segment === "**")
		return [dir, ...foldersBelow(dir, ANY_DEPTH_LIMIT, walkOpts.skip)].flatMap((folder) =>
			walk(folder, after, walkOpts, true),
		);
	if (WILDCARD.test(segment)) {
		const match = segmentPattern(segment, walkOpts.pattern);
		return entries(dir)
			.filter((entry) => match.test(entry.name))
			.map((entry) => path.join(dir, entry.name))
			.filter((found) => !walkOpts.skip(found) && (after.length === 0 || isFolder(found)))
			.flatMap((found) => walk(found, after, walkOpts, false));
	}
	const next = path.join(dir, segment);
	if (afterAnyDepth && !(after.length === 0 ? fs.existsSync(next) : isFolder(next))) return [];
	return walk(next, after, walkOpts, false);
}

/** The literal paths an absolute `pattern` stands for now; a pattern without wildcards is itself. */
export function literalPaths(pattern: string, use: Use, skip: (folder: string) => boolean = () => false): string[] {
	if (!WILDCARD.test(pattern)) return [pattern];
	const { root } = path.parse(pattern);
	const segments = pattern.slice(root.length).split(path.sep).filter(Boolean);
	const first = segments.findIndex((segment) => WILDCARD.test(segment));
	const base = path.join(root, ...segments.slice(0, first));
	return walk(base, segments.slice(first), { use, pattern, skip }, false);
}

/**
 * `policy` as bubblewrap can apply it. bubblewrap binds concrete paths: the sandbox library skips a write rule with a
 * wildcard on Linux, which would drop protected paths such as `**\/.git/hooks` and the checkouts under
 * `.octocode/worktrees/*`. Each such rule becomes the paths it matches when the command starts: a deny keeps every match
 * (a match made later is not covered), and an allow keeps only matches outside every deny, its search not entering a
 * denied folder. Rules without wildcards stay as they are; read denials stay too, as the library expands those itself.
 */
export function literalPolicy(policy: SandboxPolicy): SandboxPolicy {
	const denyWrite = [...new Set(policy.denyWrite.flatMap((pattern) => literalPaths(pattern, "deny")))];
	const denied = (file: string) => denyWrite.some((deny) => isUnderPath(file, deny));
	const allowWrite = policy.allowWrite.flatMap((pattern) =>
		WILDCARD.test(pattern) ? literalPaths(pattern, "allow", denied).filter((file) => !denied(file)) : [pattern],
	);
	return { allowWrite: [...new Set(allowWrite)], denyWrite, denyRead: policy.denyRead };
}
