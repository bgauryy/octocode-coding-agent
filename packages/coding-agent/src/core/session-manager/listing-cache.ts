import { type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import type { SessionInfo } from "./types.ts";

/**
 * Listings of files this process parsed, by path, with the file's identity then (size, modification and change times,
 * inode). A listing reuses one while the file still has that identity, so reopening the session picker parses only the
 * transcripts that changed since. Bounded by the text held (about that many bytes of mostly ASCII text): once full, a
 * newly parsed file is not kept. A listing reads every file in the same order, so evicting the oldest would evict each
 * file just before it is needed again; keeping the first ones serves them, and a changed file still replaces its own
 * entry. A file that is gone is forgotten when a listing asks for it.
 */
interface Kept {
	identity: string;
	info: SessionInfo;
	/** What the entry counts against the budget. */
	size: number;
}
const parsedInfos = new Map<string, Kept>();
/** Parses running now, so two listings of one file at once (the picker's two scopes) parse it once. */
const parsing = new Map<string, { identity: string; promise: Promise<SessionInfo | null> }>();
let parsedTextLength = 0;
const PARSED_TEXT_MAX = 32 * 1024 * 1024;
/** Counted per entry for its fields other than text (dates, counts, the object). */
const ENTRY_OVERHEAD = 256;

const fileIdentity = (stats: Stats) => `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`;

const sizeOf = (info: SessionInfo): number =>
	info.allMessagesText.length +
	info.firstMessage.length +
	info.path.length +
	(info.name?.length ?? 0) +
	(info.parentSessionPath?.length ?? 0) +
	ENTRY_OVERHEAD;

function forget(filePath: string): void {
	const known = parsedInfos.get(filePath);
	if (!known) return;
	parsedInfos.delete(filePath);
	parsedTextLength -= known.size;
}

function keep(filePath: string, identity: string, info: SessionInfo): void {
	forget(filePath);
	const size = sizeOf(info);
	if (parsedTextLength + size > PARSED_TEXT_MAX) return;
	parsedInfos.set(filePath, { identity, info, size });
	parsedTextLength += size;
}

const copy = (info: SessionInfo | null): SessionInfo | null =>
	info ? { ...info, created: new Date(info.created), modified: new Date(info.modified) } : null;

/**
 * The listing of `filePath`: this process's last parse while the file's identity is unchanged, else `parse` (given the
 * stats the identity was taken from, so a change during the parse makes the next listing parse again). A listing that
 * asks while another parses the same file at the same identity takes that parse, or parses itself if it fails. Each
 * caller gets its own copy.
 */
export async function listedSessionInfo(
	filePath: string,
	parse: (stats?: Stats) => Promise<SessionInfo | null>,
	fileStats?: Stats,
): Promise<SessionInfo | null> {
	const stats = fileStats ?? (await stat(filePath).catch(() => undefined));
	if (!stats) {
		forget(filePath);
		return parse();
	}
	const identity = fileIdentity(stats);
	const known = parsedInfos.get(filePath);
	if (known?.identity === identity) return copy(known.info);
	const running = parsing.get(filePath);
	if (running?.identity === identity) {
		const shared = await running.promise.then(copy, () => undefined);
		if (shared !== undefined) return shared;
		return parse(stats);
	}
	const promise = parse(stats).then((info) => {
		const kept = copy(info);
		if (kept) keep(filePath, identity, kept);
		else forget(filePath);
		return info;
	});
	parsing.set(filePath, { identity, promise });
	const release = () => {
		if (parsing.get(filePath)?.promise === promise) parsing.delete(filePath);
	};
	promise.then(release, release);
	return copy(await promise);
}

/** The text the kept listings count, and how many there are (tests). */
export function listedSessionInfoUsage(): { entries: number; size: number } {
	return { entries: parsedInfos.size, size: parsedTextLength };
}

/** Forget every kept listing (tests). */
export function clearListedSessionInfos(): void {
	parsedInfos.clear();
	parsedTextLength = 0;
}
