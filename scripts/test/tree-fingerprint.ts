import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Directory names (anywhere in a path) whose contents a test run itself writes. */
const EXCLUDED_SEGMENTS = new Set([".octocode", "dist", "build", "coverage", "node_modules"]);

export interface TreeFingerprint {
	hash: string;
	/** Path (repo-relative) to `status|size|mtimeMs`; `gone` replaces size and mtime for a file that no longer exists. */
	files: Map<string, string>;
}

const isExcluded = (file: string): boolean => file.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));

/** Field count before the path in a porcelain v2 record, by record type. */
const LEADING_FIELDS: Record<string, number> = { "1": 8, "2": 9, u: 10 };

/** Parse `git status --porcelain=v2 -z` into `[path, status]` pairs. A rename's origin path is its own token. */
function parseStatus(output: string): Array<[string, string]> {
	const tokens = output.split("\0");
	const entries: Array<[string, string]> = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] ?? "";
		const kind = token[0];
		if (kind === "?") entries.push([token.slice(2), "?"]);
		else if (kind && LEADING_FIELDS[kind] !== undefined) {
			const fields = token.split(" ");
			const lead = LEADING_FIELDS[kind];
			entries.push([fields.slice(lead).join(" "), fields[1] ?? ""]);
			if (kind === "2") i++;
		}
	}
	return entries;
}

function stamp(root: string, file: string, status: string): string {
	try {
		const stat = fs.statSync(path.join(root, file));
		return `${status}|${stat.size}|${stat.mtimeMs}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${status}|gone`;
		throw error;
	}
}

/**
 * Fingerprint the working tree of the git repository at `root`: `git status` (staged, unstaged and untracked paths)
 * plus each listed file's size and mtime. Paths the run itself writes (`.octocode/`, build output, coverage) are left out.
 */
export function fingerprintTree(root: string): TreeFingerprint {
	const output = execFileSync("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const files = new Map<string, string>();
	for (const [file, status] of parseStatus(output)) {
		if (!isExcluded(file)) files.set(file, stamp(root, file, status));
	}
	const hash = createHash("sha256");
	for (const file of [...files.keys()].sort()) hash.update(`${file}\0${files.get(file)}\0`);
	return { hash: hash.digest("hex"), files };
}

/** Paths present in only one fingerprint or whose stamp differs, sorted. */
export function changedPaths(before: TreeFingerprint, after: TreeFingerprint): string[] {
	if (before.hash === after.hash) return [];
	const changed = new Set<string>();
	for (const [file, value] of before.files) if (after.files.get(file) !== value) changed.add(file);
	for (const file of after.files.keys()) if (!before.files.has(file)) changed.add(file);
	return [...changed].sort();
}

/** Modified or staged (not untracked) files whose mtime is within `windowMs` of `now`. */
export function recentlyEdited(tree: TreeFingerprint, now: number, windowMs: number): string[] {
	const recent: string[] = [];
	for (const [file, value] of tree.files) {
		const [status = "", , mtime] = value.split("|");
		if (status === "?" || mtime === undefined) continue;
		if (now - Number(mtime) <= windowMs) recent.push(file);
	}
	return recent.sort();
}

const LISTED_PATHS = 10;

/** The loud end-of-run warning, or `undefined` when the tree did not change. */
export function staleTreeReport(before: TreeFingerprint, after: TreeFingerprint, rerun: string): string | undefined {
	const changed = changedPaths(before, after);
	if (changed.length === 0) return undefined;
	const shown = changed.slice(0, LISTED_PATHS).map((file) => `  ${file}`);
	if (changed.length > LISTED_PATHS) shown.push(`  … ${changed.length - LISTED_PATHS} more`);
	return [
		`tree changed during run: ${changed.length} files`,
		...shown,
		`Failures in these files may be mid-edit, not real. Rerun them: ${rerun} <failing test files>`,
	].join("\n");
}
