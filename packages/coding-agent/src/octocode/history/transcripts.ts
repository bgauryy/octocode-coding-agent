import { readWorkspaceIdentity } from "../../storage/workspace.ts";
import { registeredWorkspace } from "../../storage/workspace-database.ts";
import fs from "node:fs";
import path from "node:path";
import { archiveFolder, ownArchives, readSegments, type Segment, segmentFiles, sessionLineage } from "./archive.ts";
import { PARENT_SESSION_ENV, TEAM_WORKSPACE_ENV } from "../../../../common/src/env.ts";
import { HISTORY_BYTES, scanCursor, scanHistory, scanResume } from "./search.ts";
import { sessionsRoot } from "../shared/home.ts";
import { RECORD_FILE, type RecordHeader, readRecordHeader } from "./archive/record.ts";
import { canonicalPath } from "../../../../common/src/canonical-path.ts";
import { isWithin } from "../../../../common/src/paths.ts";

/**
 * The history a session may read: archives of compacted messages and session records (`archive.ts`). Its own
 * archive, those of the sessions it was forked from and, in a subagent, its parent's are its own history; the others of
 * the same repository (their record names it) are its repository's history. Each of those reads without asking
 * (`readableHistory`); another repository's asks. The `archive` tool searches and reads them here.
 */

type Relation = "this session" | "forked from" | "parent session" | "same repository";

export interface HistorySession {
	/** The session's folder name (its id as a folder name). */
	id: string;
	/** Scope verified from the active checkout or the explicitly inherited parent checkout. */
	workspaceId: string;
	/** Its archive folder. */
	folder: string;
	relation: Relation;
	record?: RecordHeader;
	segments: Segment[];
}

/** The session folder and archive folder `file` is in, when it is inside an archive under the sessions root. */
function archiveOwner(file: string, env: NodeJS.ProcessEnv): { id: string; folder: string } | undefined {
	const root = canonicalPath(sessionsRoot(env));
	const real = canonicalPath(file);
	if (!isWithin(real, root)) return undefined;
	const [id, kind] = path.relative(root, real).split(path.sep);
	return id && kind === "archive" ? { id, folder: path.join(root, id, "archive") } : undefined;
}

/**
 * Whether `file` is in an archive this session reads without asking: its own history (`ownArchives`), or a session's
 * whose record names the repository of `cwd`. Any other path, another repository's archive included, is not.
 */
export function readableHistory(file: string, cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (ownArchives(env).some((dir) => isWithin(canonicalPath(file), canonicalPath(dir)))) return true;
	const owner = archiveOwner(file, env);
	if (!owner) return false;
	return readRecordHeader(owner.folder)?.repository === registeredWorkspace(cwd).id;
}

/** Each archive record header read so far in this process, by folder, with the stamp of the file it was read from. */
const headers = new Map<string, { stamp: string; record: RecordHeader | undefined }>();

/** `readRecordHeader`, read again only when the record file changed since this process last read it. */
function cachedRecordHeader(folder: string): RecordHeader | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(path.join(folder, RECORD_FILE));
	} catch {
		headers.delete(folder);
		return undefined;
	}
	const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
	const known = headers.get(folder);
	if (known?.stamp === stamp) return known.record;
	const record = readRecordHeader(folder);
	headers.set(folder, { stamp, record });
	return record;
}

/** A session of the history scope, before its segments are read. */
type ScopedSession = Omit<HistorySession, "segments">;

/**
 * The sessions this session may read, in search order (`historyScope`), with their records but not their segments: what
 * a repair before a read needs (`archive/repair-stamps.ts`), at the cost of a directory listing and a stat per session.
 */
export function historySessions(cwd: string, env: NodeJS.ProcessEnv = process.env): ScopedSession[] {
	const key = registeredWorkspace(cwd).id;
	const seen = new Set<string>();
	const sessions: ScopedSession[] = [];
	const add = (folder: string, relation: Relation, record = cachedRecordHeader(folder)) => {
		const id = path.basename(path.dirname(folder));
		if (seen.has(id)) return;
		seen.add(id);
		const parentRoot = relation === "parent session" ? env[TEAM_WORKSPACE_ENV] : undefined;
		const workspaceId = parentRoot && path.isAbsolute(parentRoot) ? registeredWorkspace(parentRoot).id : key;
		sessions.push({ id, workspaceId, folder, relation, ...(record ? { record } : {}) });
	};
	const byId = (id: string | undefined, relation: Relation) => {
		if (!id) return;
		try {
			add(archiveFolder(id, env), relation);
		} catch {
			// An id that cannot name a folder has no history.
		}
	};
	add(archiveFolder(undefined, env), "this session");
	for (const id of sessionLineage()) byId(id, "forked from");
	byId(env[PARENT_SESSION_ENV]?.trim(), "parent session");

	const root = sessionsRoot(env);
	let names: string[] = [];
	try {
		names = fs.readdirSync(root);
	} catch {
		// No sessions folder: no other history.
	}
	const canonicalRoot = canonicalPath(root);
	/** Whether a record's checkout is this repository's, by checkout path: most records share a few checkouts. */
	const sameCheckout = new Map<string, boolean>();
	const ours = (workspace: string) => {
		let known = sameCheckout.get(workspace);
		if (known === undefined) {
			known = !fs.existsSync(workspace) || readWorkspaceIdentity(workspace)?.id === key;
			sameCheckout.set(workspace, known);
		}
		return known;
	};
	const others = names.flatMap((name) => {
		if (seen.has(name)) return [];
		const folder = path.join(root, name, "archive");
		const record = cachedRecordHeader(folder);
		if (record?.repository !== key || !ours(record.workspace)) return [];
		return canonicalPath(folder) === path.join(canonicalRoot, name, "archive") ? [{ folder, record }] : [];
	});
	others.sort((a, b) => (b.record.lastActive ?? "").localeCompare(a.record.lastActive ?? ""));
	for (const { folder, record } of others) add(folder, "same repository", record);
	return sessions;
}

/**
 * The sessions with history this session may read, in the order they are searched: this one, those it was forked from
 * (nearest first), its parent session, then the repository's other sessions, most recently active first. A session
 * with neither a record nor a segment is left out.
 */
export function historyScope(cwd: string, env: NodeJS.ProcessEnv = process.env): HistorySession[] {
	return historySessions(cwd, env).flatMap((session) => {
		const segments = readSegments(session.id, env);
		return session.record || segments.length ? [{ ...session, segments }] : [];
	});
}

/** One file of a session's history: its record, or a segment. */
export interface HistoryFile {
	file: string;
	session: Pick<HistorySession, "id" | "relation">;
	/** `record`, or `segment <n> · <TL;DR>`. */
	label: string;
}

/** The files of `sessions` in search order: each session's record, then its segments newest first. */
export function historyFiles(sessions: readonly HistorySession[]): HistoryFile[] {
	return sessions.flatMap((session) => {
		const tldr = new Map(session.segments.map((segment) => [segment.n, segment.tldr]));
		const record = session.record
			? [{ file: path.join(session.folder, RECORD_FILE), session, label: "record: goal and ending" }]
			: [];
		const segments = segmentFiles(session.folder)
			.reverse()
			.map(({ n, name }) => ({
				file: path.join(session.folder, name),
				session,
				label: `segment ${n}${tldr.get(n) ? ` · ${tldr.get(n)}` : ""}`,
			}));
		return [...record, ...segments];
	});
}

/** The files of `files` that are `target` or inside it (a session's archive folder); none when it names none of them. */
export function filesUnder(files: readonly HistoryFile[], target: string): HistoryFile[] {
	const real = canonicalPath(target);
	return files.filter((entry) => {
		const file = canonicalPath(entry.file);
		return file === real || isWithin(file, real);
	});
}

/** Lines shown around each hit. */
const HIT_CONTEXT = 4;
/** Characters of one page of results or of a read. */
export const PAGE_CHARS = 12_000;
/** Lines one read shows (then it continues by `line`). */
export const READ_LINES = 120;

const lineLabel = (n: number, hit: boolean) => `${hit ? ">" : " "}${String(n).padStart(6)}│ `;

/** `lines` packed into pages of at most `PAGE_CHARS` (a longer line split across pages); each page's text, in order. */
export function paginate(blocks: ReadonlyArray<{ heading?: string; lines: string[] }>): string[] {
	const pages: string[][] = [[]];
	let size = 0;
	const push = (text: string) => {
		pages.at(-1)!.push(text);
		size += text.length + 1;
	};
	for (const block of blocks) {
		const continued = block.heading ? `${block.heading} (continued)` : undefined;
		if (block.heading) {
			if (size > 0 && size + block.heading.length > PAGE_CHARS) {
				pages.push([]);
				size = 0;
			}
			push(block.heading);
		}
		for (const line of block.lines) {
			for (let at = 0; at === 0 || at < line.length; at += PAGE_CHARS) {
				const part = line.slice(at, at + PAGE_CHARS);
				if (size > 0 && size + part.length > PAGE_CHARS) {
					pages.push([]);
					size = 0;
					if (continued) push(continued);
				}
				push(part);
			}
		}
	}
	return pages.map((page) => page.join("\n"));
}

export interface HistoryPage {
	text: string;
	page: number;
	pages: number;
}

interface SearchResult extends HistoryPage {
	hits: number;
	files: number;
}

const readLines = (file: string): string[] | undefined => {
	let fd: number | undefined;
	const tooLarge = () =>
		new Error("Archive read exceeds 32 MiB; split the archive into smaller files before reading it.");
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) return undefined;
		if (stat.size > HISTORY_BYTES) throw tooLarge();
		const chunks: Buffer[] = [];
		let bytes = 0;
		for (;;) {
			const chunk = Buffer.allocUnsafe(Math.min(65_536, HISTORY_BYTES - bytes + 1));
			const count = fs.readSync(fd, chunk, 0, chunk.length, null);
			if (!count) break;
			bytes += count;
			if (bytes > HISTORY_BYTES) throw tooLarge();
			chunks.push(chunk.subarray(0, count));
		}
		return Buffer.concat(chunks).toString("utf8").split("\n");
	} catch (error) {
		if (!(error instanceof Error && "code" in error)) throw error;
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
};

/** Matching lines one search collects before it stops and offers a cursor. */
const MATCH_BUDGET = 200;

export interface HistorySearch extends SearchResult {
	/** Files read to their end by this search, of the files given; the rest, from `cursor`, were not read. */
	scanned: number;
	/** Continues the search after the last file or line read; absent when every file was read. */
	cursor?: string;
	unreadable: number;
	skippedLines: number;
}

/**
 * The lines of `files` that `pattern` matches, with `HIT_CONTEXT` lines around each, paged; `page` is 1-based. The
 * files are read in order until `MATCH_BUDGET` lines matched or the scan's time budget passed, however large they
 * are; `cursor` (from an earlier result) resumes where that stopped.
 */
export async function searchHistory(
	files: readonly HistoryFile[],
	pattern: RegExp,
	page = 1,
	signal?: AbortSignal,
	cursor?: string,
): Promise<HistorySearch> {
	const paths = files.map(({ file }) => file);
	const scan = await scanHistory(paths, pattern, signal, {
		...(cursor ? { start: scanResume(paths, cursor) } : {}),
		maxMatches: MATCH_BUDGET,
		context: HIT_CONTEXT,
	});
	signal?.throwIfAborted();
	const blocks: Array<{ heading: string; lines: string[] }> = [];
	let hits = 0;
	for (const { index: fileIndex, lines, matched } of scan.results) {
		const { file, session, label } = files[fileIndex];
		hits += matched.length;
		const hit = new Set(matched);
		const shown: string[] = [];
		let end = -1;
		for (const index of matched) {
			const from = Math.max(index - HIT_CONTEXT, end + 1);
			if (end >= 0 && from > end + 1) shown.push("     …");
			for (let at = from; at <= index + HIT_CONTEXT; at++) {
				const text = lines[at];
				if (text === undefined) continue;
				shown.push(
					`${lineLabel(at + 1, hit.has(at))}${typeof text === "number" ? `[a context line of ${text} characters, not a hit: read it with file and line ${at + 1}]` : text}`,
				);
			}
			end = Math.max(end, index + HIT_CONTEXT);
		}
		blocks.push({ heading: `## ${file} · ${session.id} (${session.relation}) · ${label}`, lines: shown });
	}
	const pages = paginate(blocks);
	const index = Math.min(Math.max(page, 1), pages.length);
	return {
		text: pages[index - 1] ?? "",
		page: index,
		pages: blocks.length === 0 ? 0 : pages.length,
		hits,
		files: blocks.length,
		scanned: scan.scanned,
		...(scan.next ? { cursor: scanCursor(paths, scan.next) } : {}),
		unreadable: scan.unreadable,
		skippedLines: scan.skippedLines,
	};
}

interface ReadResult extends HistoryPage {
	first: number;
	last: number;
	total: number;
}

/** Lines `line` to `line + READ_LINES - 1` of `file`, whole, paged; undefined when it cannot be read. */
export function readHistory(file: string, line = 1, page = 1): ReadResult | undefined {
	const lines = readLines(file);
	if (!lines) return undefined;
	const total = lines.length;
	const first = Math.min(Math.max(line, 1), total);
	const last = Math.min(first + READ_LINES - 1, total);
	const pages = paginate([
		{ lines: lines.slice(first - 1, last).map((text, index) => `${lineLabel(first + index, false)}${text}`) },
	]);
	const index = Math.min(Math.max(page, 1), pages.length);
	return { text: pages[index - 1] ?? "", page: index, pages: pages.length, first, last, total };
}
