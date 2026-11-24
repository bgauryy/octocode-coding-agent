import fs from "node:fs";
import { withoutSourceHeader } from "@octocodeai/octocode-common/text";
import path from "node:path";
import { defaultSessionDirectories, knownSessionDirectories } from "../../core/session-manager/directories.ts";
import type { CatalogEntry, CatalogRow } from "../../../../db/src/api.ts";
import { buildSessionInfo, type SessionInfoFolder, sessionInfoFolder } from "../../core/session-manager/listing.ts";
import { EntryCursor } from "../shared/entry-cursor.ts";
import { getDefaultSessionDirPath } from "../../core/session-manager/storage.ts";
import { cleanTitle } from "../../core/session-manager/title.ts";
import type { SessionEntry, SessionHeader, SessionInfo, SessionNameSource } from "../../core/session-manager/types.ts";
import type { ReadonlySessionManager } from "../../core/session-manager/api.ts";
import type { SessionIndex } from "./store.ts";

/** Most characters of a first prompt the catalog keeps. */
const FIRST_PROMPT_MAX = 200;
const NO_MESSAGES = "(no messages)";
/** Files parsed at once when a listing finds stale ones. */
const PARSE_CONCURRENCY = 8;

/** What a listing is scoped to: the sessions of one working directory (and, with `sessionDir`, that folder), or all of them. */
export interface CatalogScope {
	cwd?: string;
	/** A custom session folder (`--session-dir`); without it, Octocode's own folders. */
	sessionDir?: string;
}

/**
 * The scope that lists what the picker's full listings list for `session`: a custom `--session-dir` bounds both scopes
 * (this directory's sessions in it, or all of it); otherwise this directory's default folder, or every folder.
 */
export function listingScope(
	session: Pick<ReadonlySessionManager, "getSessionDir">,
	cwd: string,
	all: boolean,
): CatalogScope {
	const dir = session.getSessionDir();
	const custom = path.resolve(dir) === path.resolve(getDefaultSessionDirPath(cwd)) ? undefined : dir;
	if (all) return custom ? { sessionDir: custom } : {};
	return custom ? { cwd, sessionDir: custom } : { cwd };
}

/** The session as the catalog lists it: parsed from its file, so `allMessagesText` is whole; from a row it is empty. */
function rowInfo(row: CatalogRow): SessionInfo {
	const source = row.title_source;
	return {
		path: row.file,
		id: row.id,
		cwd: row.cwd,
		...(row.title ? { name: row.title } : {}),
		...(row.title && (source === "auto" || source === "goal") ? { nameSource: source } : {}),
		...(row.parent_file ? { parentSessionPath: row.parent_file } : {}),
		created: new Date(row.created_at),
		modified: new Date(row.last_active),
		messageCount: row.message_count,
		firstMessage: withoutSourceHeader(row.first_prompt ?? "") || NO_MESSAGES,
		allMessagesText: "",
	};
}

/** The catalog columns for a parsed session; `fileMtime` is the file's modification time at the parse. */
function infoEntry(info: SessionInfo, fileMtime: number | null): CatalogEntry {
	return {
		title: info.name ?? null,
		titleSource: info.name ? (info.nameSource ?? "user") : null,
		cwd: info.cwd,
		file: info.path,
		parentFile: info.parentSessionPath ?? null,
		createdAt: info.created.getTime(),
		lastActive: info.modified.getTime(),
		messageCount: info.messageCount,
		firstPrompt: info.firstMessage === NO_MESSAGES ? null : cleanTitle(info.firstMessage, FIRST_PROMPT_MAX),
		fileMtime,
	};
}

/** The file's modification time in whole milliseconds, or null when it does not exist (yet). */
function mtimeOf(file: string): number | null {
	try {
		return Math.floor(fs.statSync(file).mtimeMs);
	} catch {
		return null;
	}
}

/** Each live session's catalog fold and how far it has read, so a turn's row folds only the entries added since. */
const liveFolds = new WeakMap<object, { cursor: EntryCursor; folder: SessionInfoFolder }>();

/**
 * The live session's entries folded by the transcript listing's own fold, without message text (the row keeps none):
 * after the first, a read folds only the entries appended since (`EntryCursor`); a session it cannot prove only grew is
 * folded again from its start.
 */
function liveFolder(session: ReadonlySessionManager): SessionInfoFolder {
	let fold = liveFolds.get(session);
	if (!fold) {
		fold = { cursor: new EntryCursor(), folder: sessionInfoFolder({ text: false }) };
		liveFolds.set(session, fold);
	}
	const { restart, entries } = fold.cursor.next(session);
	if (restart) fold.folder = sessionInfoFolder({ text: false });
	try {
		for (const entry of entries) fold.folder.add(entry as SessionEntry);
	} catch (error) {
		// A half-folded entry list is not a position to resume from.
		liveFolds.delete(session);
		throw error;
	}
	return fold.folder;
}

/** The live session as a catalog entry, derived from its entries by the transcript listing's own fold. */
function liveEntry(session: {
	file: string;
	header: SessionHeader | null | undefined;
	folder: () => SessionInfoFolder;
	name: string | undefined;
	nameSource: SessionNameSource | undefined;
}): CatalogEntry | undefined {
	const { header } = session;
	if (!header) return undefined;
	const folder = session.folder();
	const mtime = mtimeOf(session.file);
	const {
		name: _fileName,
		nameSource: _fileSource,
		...info
	} = folder.info(session.file, header, new Date(mtime ?? Date.now()));
	// The live manager's name is the current one; a listing marks only generated names ("user" is the default).
	const name = session.name?.trim() || undefined;
	const source = session.nameSource === "user" ? undefined : session.nameSource;
	return infoEntry({ ...info, ...(name ? { name, ...(source ? { nameSource: source } : {}) } : {}) }, mtime);
}

/** The live session's catalog row; undefined for a session with no file. */
function sessionEntry(session: ReadonlySessionManager): CatalogEntry | undefined {
	const file = session.getSessionFile();
	if (!file) return undefined;
	return liveEntry({
		file,
		header: session.getHeader?.(),
		folder: () => liveFolder(session),
		name: session.getSessionName?.(),
		nameSource: session.getSessionNameSource?.(),
	});
}

/** Records the live session's catalog row; nothing for a session with no file. */
export function recordSession(index: SessionIndex, session: ReadonlySessionManager): void {
	const entry = sessionEntry(session);
	if (entry) index.saveCatalog(session.getSessionId(), entry);
}

/** `recordSession` through the database writer (`SessionIndex.catalogLater`), for the end of a turn. */
export async function recordSessionLater(index: SessionIndex, session: ReadonlySessionManager): Promise<void> {
	const entry = sessionEntry(session);
	if (entry) await index.catalogLater(session.getSessionId(), entry);
}

/** Records the live session's new name (undefined clears it) and the file's modification time after the name was written. */
export async function recordTitle(
	index: SessionIndex,
	session: ReadonlySessionManager,
	name: string | undefined,
	source: string | undefined,
): Promise<void> {
	const file = session.getSessionFile();
	if (file)
		await index.titleLater(session.getSessionId(), name, source, mtimeOf(file), { cwd: session.getCwd(), file });
}

/** The `.jsonl` files a scope lists, with their modification times; unreadable folders list nothing. */
async function sessionFiles(scope: CatalogScope): Promise<{ path: string; mtime: number }[]> {
	const dirs = await sessionFolders(scope);
	const found = await Promise.all(
		dirs.map(async (dir) => {
			const names = (await fs.promises.readdir(dir).catch((): string[] => [])).filter((name) =>
				name.endsWith(".jsonl"),
			);
			return Promise.all(
				names.map(async (name) => {
					const file = path.join(dir, name);
					const stats = await fs.promises.stat(file).catch(() => undefined);
					return stats ? [{ path: file, mtime: Math.floor(stats.mtimeMs) }] : [];
				}),
			);
		}),
	);
	return found.flat(2);
}

async function sessionFolders({ cwd, sessionDir }: CatalogScope): Promise<string[]> {
	if (sessionDir) return [path.resolve(sessionDir)];
	if (cwd) return defaultSessionDirectories(cwd).map((folder) => folder.dir);
	return knownSessionDirectories();
}

/**
 * Octocode's sessions of a scope, newest activity first, without parsing the transcripts the catalog already describes.
 * A file with no catalog row, or modified since its row was written, is parsed and its row written (backfilled). Rows
 * have no `allMessagesText`: a search over transcripts needs the full listing (`SessionManager.list`). A file that is
 * not a session (no header) is skipped, and nothing here rejects on a database failure: the file parse stands alone.
 */
export async function quickList(
	index: SessionIndex,
	scope: CatalogScope = {},
	parse: (file: string) => Promise<SessionInfo | null> = (file) => buildSessionInfo(file),
): Promise<SessionInfo[]> {
	const files = await sessionFiles(scope);
	let rows = new Map<string, CatalogRow>();
	try {
		rows = new Map(index.catalog().map((row) => [row.file, row]));
	} catch {
		// No database: every file is parsed.
	}
	const listed: SessionInfo[] = [];
	const stale: { path: string; mtime: number }[] = [];
	for (const file of files) {
		const row = rows.get(file.path);
		if (row && row.file_mtime !== null && file.mtime <= row.file_mtime) listed.push(rowInfo(row));
		else stale.push(file);
	}
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < stale.length) {
			const file = stale[next++];
			const info = await parse(file.path);
			if (!info) continue;
			listed.push(info);
			try {
				index.saveCatalog(info.id, infoEntry(info, file.mtime));
			} catch {
				// The listing is right; the row is only a cache.
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(PARSE_CONCURRENCY, stale.length) }, worker));
	const wanted = scope.cwd && scope.sessionDir ? path.resolve(scope.cwd) : undefined;
	return listed
		.filter((info) => !wanted || path.resolve(info.cwd || wanted) === wanted)
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
