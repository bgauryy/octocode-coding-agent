import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { Value } from "typebox/value";
import {
	DOCS_ROUTES,
	isRepoDocPath,
	REPO_DOC_PREFIX,
	DocFileSchema,
	DocsIndexSchema,
	type DocFile,
	type DocsIndex,
	type DocSummary,
} from "@octocodeai/octocode-contracts/docs";
import { mermaidScript } from "@octocodeai/octocode-webview";
import { redactData } from "@octocodeai/octocode-common/sanitize";
import { AGENT_FOLDERS } from "../../storage/agent-layout.ts";
import { workspaceAgentDir } from "../shared/home.ts";
import { docKind, MAX_DOC_BYTES, summarize } from "./doc-summary.ts";
import { isSymlink } from "./reports.ts";
import { readRepoDocFile, readRepoDocsIndex } from "./repo-docs.ts";

/**
 * Never listed as authored documents: Octocode's state and checkouts inside `.octocode/agent/`, and the repository
 * documents' own prefix. Only the top-level folder is excluded.
 */
const EXCLUDED_TOP = new Set<string>([
	AGENT_FOLDERS.marker,
	AGENT_FOLDERS.sessions,
	AGENT_FOLDERS.sessionData,
	AGENT_FOLDERS.worktrees,
	REPO_DOC_PREFIX.slice(0, -1),
]);
/** Scratch folders: listed only when the request opts in. */
const SCRATCH_TOPS = new Set<string>([AGENT_FOLDERS.tmp, AGENT_FOLDERS.temp]);
const SKIPPED_FOLDERS = new Set(["view", "node_modules"]);
const MAX_DOCS = 1000;
const MAX_FILES_SEEN = 5000;
const MAX_DEPTH = 8;

export { docKind };

function skipped(top: string, includeTmp: boolean): boolean {
	return EXCLUDED_TOP.has(top) || (SCRATCH_TOPS.has(top) && !includeTmp);
}

/** The Markdown under `.octocode/agent/` (reports, the backlog export, `MEMORY.md`) and optional scratch, newest first. Skip symbolic links. */
export function readDocsIndex(root: string, includeTmp = false): DocsIndex {
	const docs: DocSummary[] = [];
	let seen = 0;
	let capped = false;
	const walk = (directory: string, relativeDir: string, depth: number): void => {
		if (isSymlink(directory)) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (capped) return;
			if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
			const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			const top = relative.split("/")[0];
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (depth < MAX_DEPTH && !skipped(top, includeTmp) && !SKIPPED_FOLDERS.has(entry.name))
					walk(file, relative, depth + 1);
				continue;
			}
			if (!entry.isFile() || !/\.md$/i.test(entry.name) || relative.length > 300 || skipped(top, includeTmp)) continue;
			if (++seen > MAX_FILES_SEEN) {
				capped = true;
				return;
			}
			try {
				const stat = fs.statSync(file);
				if (stat.size > MAX_DOC_BYTES) continue;
				const doc = summarize(file, relative, stat.size, stat.mtime);
				if (doc) docs.push(doc);
			} catch {
				continue;
			}
		}
	};
	walk(workspaceAgentDir(root), "", 0);
	docs.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.path.localeCompare(b.path)));
	const index: DocsIndex = {
		docs: docs.slice(0, MAX_DOCS),
		truncated: capped || docs.length > MAX_DOCS,
		tmp: includeTmp,
	};
	if (!Value.Check(DocsIndexSchema, index)) throw new Error("Generated docs index violates the contracts schema");
	return index;
}

/**
 * One document. The path must be a relative `.md` path with plain segments; every segment below its permitted base must exist
 * as a regular entry, never a symbolic link, and the resolved file must stay inside the real `.octocode/agent/`, so a request
 * never turns into an arbitrary host file read.
 */
export function readDocFile(root: string, relativePath: string, includeTmp = false): DocFile | undefined {
	if (relativePath.length > 300 || relativePath.includes("\0") || relativePath.includes("\\")) return undefined;
	const segments = relativePath.split("/");
	if (segments.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return undefined;
	if (!/\.md$/i.test(relativePath) || skipped(segments[0], includeTmp)) return undefined;
	if (segments.slice(0, -1).some((part) => SKIPPED_FOLDERS.has(part)) || segments.length - 1 > MAX_DEPTH)
		return undefined;
	try {
		const base = workspaceAgentDir(root);
		if (isSymlink(base)) return undefined;
		const realBase = fs.realpathSync(base);
		let current = realBase;
		for (const part of segments) {
			current = path.join(current, part);
			if (isSymlink(current)) return undefined;
		}
		const real = fs.realpathSync(current);
		if (!real.startsWith(realBase + path.sep)) return undefined;
		const stat = fs.statSync(real);
		if (!stat.isFile() || stat.size > MAX_DOC_BYTES) return undefined;
		const payload: DocFile = { path: relativePath, markdown: fs.readFileSync(real, "utf8") };
		return Value.Check(DocFileSchema, payload) ? payload : undefined;
	} catch {
		return undefined;
	}
}

type Reply = (status: number, body: unknown) => void;

/** The authored index plus, for a trusted project, its git-tracked Markdown. An untrusted project runs no git and is reported as hidden. */
async function docsIndexWithRepo(root: string, includeTmp: boolean, trusted: boolean): Promise<DocsIndex> {
	const index = readDocsIndex(root, includeTmp);
	if (!trusted) return { ...index, repoDocsHidden: true };
	const repoDocs = await readRepoDocsIndex(root);
	const room = Math.max(0, MAX_DOCS - index.docs.length);
	const merged: DocsIndex = {
		...index,
		docs: [...index.docs, ...repoDocs.slice(0, room)],
		truncated: index.truncated || repoDocs.length > room,
	};
	if (!Value.Check(DocsIndexSchema, merged)) throw new Error("Generated docs index violates the contracts schema");
	return merged;
}

/** Whether a project's repository documents may be shown; the host supplies it (workspace does not know about folder trust). */
export type RepoDocsTrusted = (root: string) => boolean;

/** The answer when no host supplies a trust check: repository documents stay hidden. */
export const repoDocsNeverTrusted: RepoDocsTrusted = () => false;

/**
 * The docs library's read-only routes, called only after the loopback host, origin and bearer capability have been
 * checked. Returns true when the request was answered.
 */
export async function handleDocsRequest(
	req: IncomingMessage,
	url: URL,
	repoRoot: string | undefined,
	reply: Reply,
	trusted: RepoDocsTrusted,
): Promise<boolean> {
	const route = Object.values(DOCS_ROUTES).find((value) => value === url.pathname);
	if (!route) return false;
	if (req.method !== "GET") {
		reply(405, { error: "Docs are read-only." });
		return true;
	}
	if (route === DOCS_ROUTES.mermaid) {
		reply(200, { script: await mermaidScript() });
		return true;
	}
	const includeTmp = url.searchParams.get("tmp") === "1";
	if (route === DOCS_ROUTES.index) {
		const index = repoRoot
			? await docsIndexWithRepo(repoRoot, includeTmp, trusted(repoRoot))
			: { docs: [], truncated: false, tmp: false };
		reply(200, redactData(index));
		return true;
	}
	const requested = url.searchParams.get("path") ?? "";
	if (repoRoot && isRepoDocPath(requested)) {
		if (!trusted(repoRoot)) {
			reply(403, {
				error: "Repository documents are shown only in a trusted project. Run `octocode trust add` in a terminal.",
			});
			return true;
		}
		const repoDoc = await readRepoDocFile(repoRoot, requested);
		reply(repoDoc ? 200 : 404, repoDoc ? redactData(repoDoc) : { error: "Document not found in this workspace" });
		return true;
	}
	const doc = repoRoot ? readDocFile(repoRoot, requested, includeTmp) : undefined;
	reply(doc ? 200 : 404, doc ? redactData(doc) : { error: "Document not found in this workspace" });
	return true;
}
