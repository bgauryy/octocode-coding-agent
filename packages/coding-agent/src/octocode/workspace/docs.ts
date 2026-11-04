import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { Value } from "typebox/value";
import {
	DOCS_ROUTES,
	DocFileSchema,
	DocsIndexSchema,
	type DocFile,
	type DocKind,
	type DocsIndex,
	type DocSummary,
} from "@octocodeai/octocode-contracts/docs";
import { mermaidScript } from "@octocodeai/octocode-webview";
import { redactData } from "../../../../common/src/sanitize.ts";
import { WORKSPACE_STATE, workspaceStateDir } from "../../config/workspace.ts";
import { workspaceOctocodeDir } from "../shared/home.ts";
import { firstHeading, isSymlink, readFrontmatter, truncate } from "./reports.ts";

/**
 * Never listed as authored documents: the saved skill output of other tools, and the workspace state folder inside
 * `.octocode/` (listed only through its backlog export and opted-in scratch). Only the top-level folder is excluded.
 */
const EXCLUDED_TOP = new Set(["skills", WORKSPACE_STATE.split(path.sep)[1]]);
/** Scratch space: listed only when the request opts in. */
const SCRATCH_TOP = "tmp";
const RUNTIME_PREFIX = WORKSPACE_STATE.split(path.sep).join("/") + "/";
const SKIPPED_FOLDERS = new Set(["view", "node_modules"]);
const MAX_DOC_BYTES = 512 * 1024;
const MAX_DOCS = 1000;
const MAX_FILES_SEEN = 5000;
const MAX_DEPTH = 8;
/** Title, status and question come from the head of the file; the rest is read only when the document is opened. */
const HEAD_BYTES = 16 * 1024;

const FOLDER_KINDS: readonly [RegExp, DocKind][] = [
	[/rfc/i, "rfc"],
	[/brainstorm/i, "brainstorm"],
	[/research/i, "research"],
	[/audit/i, "audit"],
	[/review/i, "review"],
	[/plan/i, "plan"],
	[/contract/i, "contract"],
];
const FILE_KINDS: readonly [RegExp, DocKind][] = [
	[/^rfc\b/i, "rfc"],
	[/^plan\b/i, "plan"],
	[/^contract\b/i, "contract"],
	[/review/i, "review"],
	[/audit/i, "audit"],
];

/** The kind of a document: its top-level folder decides, then its file name, else a plain report. */
export function docKind(relativePath: string): DocKind {
	const parts = relativePath.split("/");
	if (parts.length > 1) for (const [pattern, kind] of FOLDER_KINDS) if (pattern.test(parts[0])) return kind;
	const file = parts[parts.length - 1];
	for (const [pattern, kind] of FILE_KINDS) if (pattern.test(file)) return kind;
	return "report";
}

function skipped(top: string, includeTmp: boolean): boolean {
	return EXCLUDED_TOP.has(top) || (top === SCRATCH_TOP && !includeTmp);
}

function readHead(filePath: string): string {
	const fd = fs.openSync(filePath, "r");
	try {
		const buffer = Buffer.alloc(HEAD_BYTES);
		return buffer.subarray(0, fs.readSync(fd, buffer, 0, HEAD_BYTES, 0)).toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

function summarize(file: string, relativePath: string, size: number, modified: Date): DocSummary | undefined {
	try {
		const head = readHead(file);
		const frontmatter = readFrontmatter(head);
		const parts = relativePath.split("/");
		return {
			path: relativePath,
			kind: docKind(relativePath),
			topic: parts.length > 1 ? parts[0] : "",
			title: (firstHeading(head) || frontmatter.title || parts[parts.length - 1].replace(/\.md$/i, "")).slice(0, 300),
			updated: modified.toISOString(),
			bytes: size,
			status: truncate(frontmatter.status, 40),
			question: truncate(frontmatter.question, 2000),
		};
	} catch {
		return undefined; // An unreadable file is left out, not half-listed.
	}
}

/** Authored documents, the backlog export, and optional runtime scratch, newest first. Skip symbolic links. */
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
	walk(workspaceOctocodeDir(root), "", 0);
	try {
		const state = workspaceStateDir(root);
		const file = path.join(state, "backlog.md");
		const stat = fs.lstatSync(file, { throwIfNoEntry: false });
		if (stat?.isFile() && stat.size <= MAX_DOC_BYTES) {
			const doc = summarize(file, RUNTIME_PREFIX + "backlog.md", stat.size, stat.mtime);
			if (doc) docs.push(doc);
		}
		if (includeTmp) walk(path.join(state, "temp"), RUNTIME_PREFIX + "temp", 1);
	} catch {
		// Runtime output is optional; an inaccessible state directory cannot hide authored documents.
	}
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
 * as a regular entry, never a symbolic link, and the resolved file must stay inside the real `.octocode/`, so a request
 * never turns into an arbitrary host file read.
 */
export function readDocFile(root: string, relativePath: string, includeTmp = false): DocFile | undefined {
	if (relativePath.length > 300 || relativePath.includes("\0") || relativePath.includes("\\")) return undefined;
	const runtime = relativePath.startsWith(RUNTIME_PREFIX);
	const relative = runtime ? relativePath.slice(RUNTIME_PREFIX.length) : relativePath;
	if (runtime && relative !== "backlog.md" && !(includeTmp && relative.startsWith("temp/"))) return undefined;
	const segments = relative.split("/");
	if (segments.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return undefined;
	if (!/\.md$/i.test(relativePath) || skipped(segments[0], includeTmp)) return undefined;
	if (segments.slice(0, -1).some((part) => SKIPPED_FOLDERS.has(part)) || segments.length - 1 > MAX_DEPTH)
		return undefined;
	try {
		const base = runtime ? workspaceStateDir(root) : workspaceOctocodeDir(root);
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

/**
 * The docs library's read-only routes, called only after the loopback host, origin and bearer capability have been
 * checked. Returns true when the request was answered.
 */
export async function handleDocsRequest(
	req: IncomingMessage,
	url: URL,
	repoRoot: string | undefined,
	reply: Reply,
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
		reply(200, repoRoot ? redactData(readDocsIndex(repoRoot, includeTmp)) : { docs: [], truncated: false, tmp: false });
		return true;
	}
	const doc = repoRoot ? readDocFile(repoRoot, url.searchParams.get("path") ?? "", includeTmp) : undefined;
	reply(doc ? 200 : 404, doc ? redactData(doc) : { error: "Document not found in this workspace" });
	return true;
}
