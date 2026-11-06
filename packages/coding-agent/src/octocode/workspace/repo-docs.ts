import fs from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { DocFileSchema, REPO_DOC_PREFIX, type DocFile, type DocSummary } from "@octocodeai/octocode-contracts/docs";
import { git } from "../shared/git.ts";
import { MAX_DOC_BYTES, summarize } from "./doc-summary.ts";
import { isSymlink } from "./reports.ts";

/** Authored documents live in `.octocode/`; the docs library lists them itself, so the repository listing leaves them out. */
const AUTHORED_PREFIX = ".octocode/";
const MAX_TRACKED = 5000;
const MAX_PATH = 300 - REPO_DOC_PREFIX.length;
const GIT_TIMEOUT_MS = 10_000;

/**
 * The git-tracked `*.md` paths below `root`, relative to it. A folder that is not a git repository, or where git fails,
 * has none: nothing is listed from the working tree itself, so an untracked file is never offered.
 */
async function trackedMarkdown(root: string): Promise<string[]> {
	let output: string;
	try {
		output = await git(root, ["ls-files", "-z", "--cached", "--", ":(icase)*.md"], {
			raw: true,
			timeoutMs: GIT_TIMEOUT_MS,
		});
	} catch {
		return [];
	}
	return output
		.split("\0")
		.filter(
			(file) =>
				file &&
				file.length <= MAX_PATH &&
				!file.startsWith(AUTHORED_PREFIX) &&
				!file.split("/").some((part) => part === "node_modules" || part === ".." || part === "."),
		)
		.slice(0, MAX_TRACKED);
}

/** Tracked regular files only: a symbolic link, a file missing from the working tree or an oversized one is left out. */
export async function readRepoDocsIndex(root: string): Promise<DocSummary[]> {
	const docs: DocSummary[] = [];
	for (const relative of await trackedMarkdown(root)) {
		try {
			const file = path.join(root, relative);
			const stat = fs.lstatSync(file);
			if (!stat.isFile() || stat.size > MAX_DOC_BYTES) continue;
			const doc = summarize(file, REPO_DOC_PREFIX + relative, stat.size, stat.mtime, relative);
			if (doc) docs.push(doc);
		} catch {
			continue; // Tracked but deleted or unreadable: not listed.
		}
	}
	return docs.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.path.localeCompare(b.path)));
}

/**
 * One repository document. The path must be exactly one the listing offers (a tracked `*.md`); every segment must be a
 * regular entry, never a symbolic link, and the resolved file must stay inside the real root.
 */
export async function readRepoDocFile(root: string, requested: string): Promise<DocFile | undefined> {
	if (!requested.startsWith(REPO_DOC_PREFIX)) return undefined;
	const relative = requested.slice(REPO_DOC_PREFIX.length);
	if (!(await trackedMarkdown(root)).includes(relative)) return undefined;
	try {
		const realRoot = fs.realpathSync(root);
		let current = realRoot;
		for (const part of relative.split("/")) {
			current = path.join(current, part);
			if (isSymlink(current)) return undefined;
		}
		const real = fs.realpathSync(current);
		if (!real.startsWith(realRoot + path.sep)) return undefined;
		const stat = fs.statSync(real);
		if (!stat.isFile() || stat.size > MAX_DOC_BYTES) return undefined;
		const payload: DocFile = { path: requested, markdown: fs.readFileSync(real, "utf8") };
		return Value.Check(DocFileSchema, payload) ? payload : undefined;
	} catch {
		return undefined;
	}
}
