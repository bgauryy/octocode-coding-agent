import fs from "node:fs";
import path from "node:path";
import { resolveToolPath } from "./home.ts";
import { canonicalPath } from "./home/repo.ts";
import { sha256, sha256File } from "../../../../common/src/atomic-file.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { LOCAL_READ_TOOLS, OCTOCODE_TOOL_PREFIX } from "../../../../mcp/src/presets/octocode/names.ts";
export { LOCAL_READ_TOOLS } from "../../../../mcp/src/presets/octocode/names.ts";

interface LocalRead {
	file: string;
	sha256: string;
	size: number;
	whole: boolean;
	lines?: readonly [number, number];
}

/** Add copyable source identities to the model's visible result, without changing the server's structured data. */
export function appendReadDigests<T extends { type: string }>(
	content: readonly T[],
	reads: readonly LocalRead[],
	options: { nested?: boolean; truncated?: boolean } = {},
): Array<T | { type: "text"; text: string }> {
	if (options.nested || options.truncated || !content.some((part) => part.type === "text")) return [...content];
	const sources = new Map<string, string>();
	for (const read of reads) {
		if (read.whole && path.isAbsolute(read.file) && /^[a-f0-9]{64}$/.test(read.sha256))
			sources.set(read.file, read.sha256);
	}
	if (!sources.size) return [...content];
	const lines = [...sources].map(([file, digest]) => `sourceSha256=${digest} path=${JSON.stringify(file)}`);
	return [...content, { type: "text", text: `Whole-source SHA-256 for optional anchored edits:\n${lines.join("\n")}` }];
}

/** A file's identity before retrieval; a searched directory has no file identity, only `searchedAt`, when the search began. */
type Snapshot = { sha256: string; size: number; mtimeMs: number; ctimeMs: number; searchedAt?: number };

const SEARCH_TOOL = `${OCTOCODE_TOOL_PREFIX}localSearch`;
/** A search row's lines are checked against the whole file; a larger file is not credited (read it with localFetch). */
const SEARCH_CREDIT_MAX_BYTES = 2 * 1024 * 1024;

/** Capture requested files before retrieval so a changed file cannot be credited as the returned version. */
export async function snapshotLocalReads(
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
): Promise<Map<string, Snapshot>> {
	const snapshots = new Map<string, Snapshot>();
	if (!LOCAL_READ_TOOLS.has(tool) && tool !== SEARCH_TOOL) return snapshots;
	for (const query of Array.isArray(input.queries) ? input.queries : []) {
		if (!isRecord(query) || typeof query.path !== "string") continue;
		const file = canonicalPath(resolveToolPath(cwd, query.path));
		try {
			const stat = fs.statSync(file);
			if (stat.isDirectory() && tool === SEARCH_TOOL) {
				snapshots.set(file, { sha256: "", size: 0, mtimeMs: 0, ctimeMs: 0, searchedAt: Date.now() });
				continue;
			}
			const sha256 = stat.isFile() ? await sha256File(file) : undefined;
			if (sha256) snapshots.set(file, { sha256, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
		} catch {
			/* Retrieval reports unreadable paths. */
		}
	}
	return snapshots;
}

/**
 * Credit only successful, untransformed source windows from files unchanged throughout retrieval. The server leaves a
 * row's `path` out when it repeats the request's, so such a row names the file of `input.queries[row.index]`.
 */
export async function completedLocalReads(
	snapshots: Map<string, Snapshot>,
	output: unknown,
	cwd: string,
	input?: unknown,
): Promise<LocalRead[]> {
	// MCP results may expose server data directly or wrap it in CallToolResult.
	if (isRecord(output) && isRecord(output.structuredContent)) {
		if (output.isError === true) return [];
		output = output.structuredContent;
	}
	if (!isRecord(output) || !Array.isArray(output.results)) return [];
	const queries = isRecord(input) && Array.isArray(input.queries) ? input.queries : [];
	const reads: LocalRead[] = [];
	for (const [position, row] of output.results.entries()) {
		if (!isRecord(row) || row.status === "error" || !isRecord(row.data)) continue;
		const data = row.data;
		const query: unknown = queries[nonnegative(row.index) ? row.index : position];
		if (Array.isArray(data.files)) {
			const root = output.root ?? output.base;
			const baseDir = typeof root === "string" && path.isAbsolute(root) ? root : cwd;
			reads.push(...searchReads(snapshots, data, baseDir));
			continue;
		}
		if (
			data.error ||
			(data.contentView && data.contentView !== "none") ||
			data.selection ||
			data.isSkeleton ||
			data.matchNotFound ||
			typeof data.content !== "string"
		)
			continue;
		let file: string;
		if (typeof data.path === "string") {
			const root = output.root ?? output.base;
			const baseDir = typeof root === "string" && path.isAbsolute(root) ? root : cwd;
			file = canonicalPath(path.isAbsolute(data.path) ? data.path : resolveToolPath(baseDir, data.path));
		} else if (isRecord(query) && typeof query.path === "string") {
			// The request's own path, resolved as `snapshotLocalReads` resolved it.
			file = canonicalPath(resolveToolPath(cwd, query.path));
		} else continue;
		const before = snapshots.get(file);
		if (!before) continue;
		try {
			const stat = fs.statSync(file);
			if (
				stat.size !== before.size ||
				stat.mtimeMs !== before.mtimeMs ||
				stat.ctimeMs !== before.ctimeMs ||
				(await sha256File(file)) !== before.sha256
			)
				continue;
		} catch {
			continue;
		}
		const base = { file, sha256: before.sha256, size: before.size };
		if (data.contentView === "none") {
			if (
				data.isPartial ||
				(isRecord(data.pagination) && (data.pagination.hasMore || data.pagination.charOffset !== 0))
			)
				continue;
			if (sha256(Buffer.from(data.content)) === before.sha256) reads.push({ ...base, whole: true });
			else if (positive(data.startLine) && positive(data.endLine) && data.endLine >= data.startLine)
				reads.push({ ...base, whole: false, lines: [data.startLine, data.endLine] });
			continue;
		}
		if (isRecord(data.pagination) && data.pagination.unit !== "lines") continue;
		// Separated ranges come joined by a `--` line, as grep joins context groups; every source line carries its number.
		const lines = data.content.split("\n").filter((line) => line !== "--");
		if (lines.at(-1) === "") lines.pop();
		if (!lines.length && data.totalLines === 0) {
			reads.push({ ...base, whole: true });
			continue;
		}
		const numbered = lines.map((line) => /^(\d+)\t/.exec(line)?.[1]).map(Number);
		if (!numbered.length || numbered.some((line) => !positive(line))) continue;
		const spans: Array<[number, number]> = [];
		for (const line of [...new Set(numbered)].sort((a, b) => a - b)) {
			const last = spans.at(-1);
			if (last && line === last[1] + 1) last[1] = line;
			else spans.push([line, line]);
		}
		const whole =
			data.isPartial !== true &&
			data.terminalLimit !== true &&
			spans.length === 1 &&
			spans[0][0] === 1 &&
			spans[0][1] === data.totalLines;
		if (whole) reads.push({ ...base, whole: true });
		else for (const lines of spans) reads.push({ ...base, whole: false, lines });
	}
	return reads;
}

/**
 * The source lines a `localSearch` content row showed, as partial reads. A line counts only when its shown text is
 * exactly that line of the file as it was before the search began, so a sanitized, shortened or stale line, and a
 * `matchOnly` match (which carries a `column`), never count. A searched directory's files count when they were last
 * modified before the search began.
 */
function searchReads(snapshots: Map<string, Snapshot>, data: Record<string, unknown>, baseDir: string): LocalRead[] {
	if (data.error) return [];
	const reads: LocalRead[] = [];
	for (const entry of data.files as unknown[]) {
		if (
			!isRecord(entry) ||
			typeof entry.path !== "string" ||
			!Array.isArray(entry.matches) ||
			entry.clipped ||
			entry.truncated
		)
			continue;
		const file = canonicalPath(path.isAbsolute(entry.path) ? entry.path : resolveToolPath(baseDir, entry.path));
		const source = unchangedSource(file, snapshots);
		if (!source) continue;
		const shown = new Set<number>();
		for (const match of entry.matches as unknown[]) {
			if (!isRecord(match) || typeof match.value !== "string" || match.clipped || match.truncated || "column" in match)
				continue;
			for (const [number, text] of shownLines(match)) if (source.lines[number - 1] === text) shown.add(number);
		}
		const spans: Array<[number, number]> = [];
		for (const line of [...shown].sort((a, b) => a - b)) {
			const last = spans.at(-1);
			if (last && line === last[1] + 1) last[1] = line;
			else spans.push([line, line]);
		}
		for (const lines of spans) reads.push({ file, sha256: source.sha256, size: source.size, whole: false, lines });
	}
	return reads;
}

/** `[line number, text]` of each line a match row shows: numbered when it has context, else its one `line`. */
function shownLines(match: Record<string, unknown>): Array<[number, string]> {
	const value = String(match.value);
	const numbered = value.split("\n").map((line) => /^(\d+)\t([\s\S]*)$/.exec(line));
	if (numbered.every((line) => line !== null))
		return numbered.map((line) => [Number(line[1]), line[2]] as [number, string]);
	return positive(match.line) && !value.includes("\n") ? [[match.line, value]] : [];
}

/** The file's lines when it is unchanged since the snapshot of its search (or since before it began, for a directory). */
function unchangedSource(
	file: string,
	snapshots: Map<string, Snapshot>,
): { sha256: string; size: number; lines: string[] } | undefined {
	const before = snapshots.get(file);
	let searchedAt: number | undefined;
	if (!before?.sha256)
		for (const [dir, snapshot] of snapshots)
			if (snapshot.searchedAt !== undefined && file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep))
				searchedAt = snapshot.searchedAt;
	if (!before?.sha256 && searchedAt === undefined) return undefined;
	try {
		const stat = fs.statSync(file);
		if (stat.size > SEARCH_CREDIT_MAX_BYTES) return undefined;
		const data = fs.readFileSync(file);
		const digest = sha256(data);
		if (before?.sha256) {
			if (stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs)
				return undefined;
			if (digest !== before.sha256) return undefined;
		} else if (searchedAt !== undefined && Math.max(stat.mtimeMs, stat.ctimeMs) >= searchedAt) return undefined;
		const after = fs.statSync(file);
		if (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.size !== data.length)
			return undefined;
		return { sha256: digest, size: data.length, lines: data.toString("utf8").split("\n") };
	} catch {
		return undefined;
	}
}

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Read metadata survives transcript persistence and read-result deduplication. */
export function recordedLocalReads(details: unknown): LocalRead[] {
	if (!isRecord(details) || !Array.isArray(details.localReads)) return [];
	return details.localReads.filter(
		(read): read is LocalRead =>
			isRecord(read) &&
			typeof read.file === "string" &&
			path.isAbsolute(read.file) &&
			typeof read.sha256 === "string" &&
			/^[a-f0-9]{64}$/.test(read.sha256) &&
			nonnegative(read.size) &&
			typeof read.whole === "boolean" &&
			(read.whole ||
				(Array.isArray(read.lines) &&
					read.lines.length === 2 &&
					positive(read.lines[0]) &&
					positive(read.lines[1]) &&
					read.lines[1] >= read.lines[0])),
	);
}
