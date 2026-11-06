import fs from "node:fs";
import type { DocKind, DocSummary } from "@octocodeai/octocode-contracts/docs";
import { firstHeading, readFrontmatter, truncate } from "./reports.ts";

export const MAX_DOC_BYTES = 512 * 1024;
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

function readHead(filePath: string): string {
	const fd = fs.openSync(filePath, "r");
	try {
		const buffer = Buffer.alloc(HEAD_BYTES);
		return buffer.subarray(0, fs.readSync(fd, buffer, 0, HEAD_BYTES, 0)).toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * The listing row of one file. `relativePath` is what the row carries as `path`; `kindPath` (default: the same) is the
 * path below the document root that decides its kind and topic.
 */
export function summarize(
	file: string,
	relativePath: string,
	size: number,
	modified: Date,
	kindPath = relativePath,
): DocSummary | undefined {
	try {
		const head = readHead(file);
		const frontmatter = readFrontmatter(head);
		const parts = kindPath.split("/");
		return {
			path: relativePath,
			kind: docKind(kindPath),
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
