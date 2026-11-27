import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { Message } from "@octocodeai/octocode-ai";
import { createReadStream, existsSync, readdirSync, type Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { defaultSessionDirectories, knownSessionDirectories, type CwdSessionDirectory } from "./directories.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { mapConcurrent } from "@octocodeai/octocode-common/map-concurrent";
import { normalizePath, resolvePath } from "@octocodeai/octocode-common/paths";
import { withoutSourceHeader } from "@octocodeai/octocode-common/text";
import {
	getDefaultSessionDirPath,
	getSessionHeaderCwd,
	readSessionHeaderForDiscovery,
	sessionCwdMatches,
} from "./storage.ts";
import { parseSessionEntryLine } from "./entries.ts";
import { sessionMirrorSettled } from "./mirror.ts";
import { listedSessionInfo } from "./listing-cache.ts";
import type { SessionEntry, SessionHeader, SessionInfo, SessionListProgress, SessionMessageEntry } from "./types.ts";

function isMessageWithContent(message: AgentMessage): message is Message {
	return isRecord(message) && typeof message.role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) =>
			isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
		)
		.join(" ");
}

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

/** A fold of one session's entries into its listing; `info` can be read between `add`s. */
export interface SessionInfoFolder {
	add(entry: SessionEntry): void;
	/** The info for `header`; `fallbackModified` dates a session with no timed message and no valid header time. */
	info(filePath: string, header: SessionHeader, fallbackModified: Date): SessionInfo;
}

/**
 * Folds a session's entries after its header, in file order, into what a listing shows. The file listing
 * (`buildSessionInfo`) and the live session's catalog row (`octocode/sessions/catalog.ts`) share it, so both derive the
 * same name, first prompt, message count and activity time. With `text: false` the fold keeps no message text
 * (`allMessagesText` is empty): the catalog row has no column for it, and joining a long session's text after every
 * reply cost more than the rest of the fold.
 */
export function sessionInfoFolder(options: { text?: boolean } = {}): SessionInfoFolder {
	const keepText = options.text !== false;
	let messageCount = 0;
	let firstMessage = "";
	const allMessages: string[] = [];
	let name: string | undefined;
	let nameSource: SessionInfo["nameSource"];
	let lastActivityTime: number | undefined;
	return {
		add(entry) {
			// Extract session name (use latest, including explicit clears)
			if (entry.type === "session_info") {
				name = entry.name?.trim() || undefined;
				nameSource = name ? entry.source : undefined;
			}

			if (entry.type !== "message") return;
			messageCount++;

			const activityTime = getMessageActivityTime(entry);
			if (typeof activityTime === "number") {
				lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			}

			const message = entry.message;
			if (!isMessageWithContent(message)) return;
			if (message.role !== "user" && message.role !== "assistant") return;
			// Without text, only the first user prompt is still wanted.
			if (!keepText && (firstMessage || message.role !== "user")) return;

			const textContent = extractTextContent(message);
			if (!textContent) return;

			if (keepText) allMessages.push(textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = withoutSourceHeader(textContent);
			}
		},
		info(filePath, header, fallbackModified) {
			const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
			const modified =
				typeof lastActivityTime === "number" && lastActivityTime > 0
					? new Date(lastActivityTime)
					: !Number.isNaN(headerTime)
						? new Date(headerTime)
						: fallbackModified;
			return {
				path: filePath,
				id: header.id,
				cwd: typeof header.cwd === "string" ? header.cwd : "",
				name,
				...(nameSource ? { nameSource } : {}),
				parentSessionPath: header.parentSession,
				created: new Date(header.timestamp),
				modified,
				messageCount,
				firstMessage: firstMessage || "(no messages)",
				allMessagesText: allMessages.join(" "),
			};
		},
	};
}

export async function buildSessionInfo(
	filePath: string,
	signal?: AbortSignal,
	fileStats?: Stats,
): Promise<SessionInfo | null> {
	try {
		const stats = fileStats ?? (await stat(filePath));
		let header: SessionHeader | null = null;
		const folder = sessionInfoFolder();

		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf8", signal }),
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			const entry = parseSessionEntryLine(line);
			if (!entry) continue;

			if (!header) {
				if (entry.type !== "session" || typeof entry.id !== "string") return null;
				header = entry;
				continue;
			}
			if (entry.type !== "session") folder.add(entry);
		}

		if (!header) return null;
		return folder.info(filePath, header, stats.mtime);
	} catch {
		signal?.throwIfAborted();
		return null;
	}
}

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;
const MAX_CONCURRENT_SESSION_DISCOVERY_LOADS = 64;
/** Longest a listing of every folder waits for this process's pending mirror writes (`mirror.ts`) before it lists. */
export const LIST_MIRROR_WAIT_MS = 2_000;
const CURRENT_SESSION_LIST_PUBLISH_INTERVAL = 10;
const ALL_SESSION_LIST_PUBLISH_INTERVAL = 100;

interface SessionFileCandidate {
	path: string;
	stats?: Stats;
}

function sortSessionInfos(sessions: SessionInfo[]): SessionInfo[] {
	return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

function buildSessionInfosWithConcurrency(
	files: SessionFileCandidate[],
	onLoaded: (info: SessionInfo | null, index: number) => void,
	signal?: AbortSignal,
): Promise<(SessionInfo | null)[]> {
	return mapConcurrent(
		files,
		MAX_CONCURRENT_SESSION_INFO_LOADS,
		async (file, index) => {
			const info = await listedSessionInfo(
				file.path,
				(stats) => buildSessionInfo(file.path, signal, stats),
				file.stats,
			);
			onLoaded(info, index);
			return info;
		},
		signal,
	);
}

async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	signal?.throwIfAborted();
	if (!existsSync(dir)) return [];

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries
			.filter((file) => file.endsWith(".jsonl"))
			.sort((a, b) => b.localeCompare(a))
			.map((file) => ({ path: join(dir, file) }));
		const total = files.length;
		const partialSessions: SessionInfo[] = [];
		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(
			files,
			(info) => {
				loaded++;
				if (info) partialSessions.push(info);
				const publishPartial =
					loaded === 1 || loaded % CURRENT_SESSION_LIST_PUBLISH_INTERVAL === 0 || loaded === files.length;
				onProgress?.(loaded, total, publishPartial ? sortSessionInfos([...partialSessions]) : undefined);
			},
			signal,
		);
		return results.filter((info): info is SessionInfo => info !== null);
	} catch {
		signal?.throwIfAborted();
		return [];
	}
}

/** The folders `cwd` lists: the one custom folder (filtered by cwd unless it is the default), or the default folders. */
export function cwdFolders(cwd: string, sessionDir?: string): CwdSessionDirectory[] {
	const dir = sessionDir ? normalizePath(sessionDir) : undefined;
	if (!dir || dir === getDefaultSessionDirPath(cwd)) return defaultSessionDirectories(cwd);
	return [{ dir, filterCwd: true }];
}

/** Find an exact session ID without loading transcript bodies (`SessionManager.findById()`). */
export function findSessionFileById(cwd: string, id: string, sessionDir?: string): string | undefined {
	const resolvedCwd = resolvePath(cwd);
	for (const { dir, filterCwd } of cwdFolders(cwd, sessionDir)) {
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".jsonl")) continue;
				const path = join(dir, file);
				const header = readSessionHeaderForDiscovery(path);
				if (header?.id !== id) continue;
				if (filterCwd && !sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd)) continue;
				return path;
			}
		} catch {
			// Exact session discovery is best-effort, matching list().
		}
	}
	return undefined;
}

export async function listSessions(
	cwd: string,
	sessionDir?: string,
	onProgress?: SessionListProgress,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	const resolvedCwd = resolvePath(cwd);
	const sessions: SessionInfo[] = [];
	for (const { dir, filterCwd } of cwdFolders(cwd, sessionDir)) {
		const includeSession = (session: SessionInfo) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd);
		// Progress covers each folder in turn; partial snapshots add what earlier folders listed.
		const progress: SessionListProgress | undefined = onProgress
			? (loaded, total, partial) =>
					onProgress(loaded, total, partial && sortSessionInfos([...sessions, ...partial.filter(includeSession)]))
			: undefined;
		sessions.push(...(await listSessionsFromDir(dir, progress, signal)).filter(includeSession));
	}
	return sortSessionInfos(sessions);
}

/** List all sessions across all project directories (`SessionManager.listAll()` overloads). */
export async function listAllSessions(
	sessionDirOrOnProgress?: string | SessionListProgress,
	onProgressOrSignal?: SessionListProgress | AbortSignal,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	const customSessionDir =
		typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
	const progress =
		typeof sessionDirOrOnProgress === "function"
			? sessionDirOrOnProgress
			: typeof onProgressOrSignal === "function"
				? onProgressOrSignal
				: undefined;
	const abortSignal =
		typeof sessionDirOrOnProgress === "string" || typeof onProgressOrSignal === "function"
			? signal
			: (onProgressOrSignal ?? signal);
	abortSignal?.throwIfAborted();
	if (customSessionDir) {
		return sortSessionInfos(await listSessionsFromDir(customSessionDir, progress, abortSignal));
	}

	try {
		// A workspace this process wrote its first session in is registered by the database writer: wait for it, bounded.
		await sessionMirrorSettled(LIST_MIRROR_WAIT_MS);
		const dirs = await knownSessionDirectories();

		const dirFiles = await mapConcurrent(
			dirs,
			MAX_CONCURRENT_SESSION_DISCOVERY_LOADS,
			async (dir) => {
				try {
					return (await readdir(dir)).filter((file) => file.endsWith(".jsonl")).map((file) => join(dir, file));
				} catch {
					// One project's folder that is gone or unreadable must not hide every other project's sessions.
					return [];
				}
			},
			abortSignal,
		);
		const allFiles = [...new Set(dirFiles.flat())];
		const candidates = await mapConcurrent(
			allFiles,
			MAX_CONCURRENT_SESSION_DISCOVERY_LOADS,
			async (path): Promise<SessionFileCandidate> => {
				try {
					return { path, stats: await stat(path) };
				} catch {
					return { path };
				}
			},
			abortSignal,
		);
		candidates.sort(
			(a, b) =>
				(b.stats?.mtimeMs ?? Number.NEGATIVE_INFINITY) - (a.stats?.mtimeMs ?? Number.NEGATIVE_INFINITY) ||
				basename(b.path).localeCompare(basename(a.path)),
		);

		const totalFiles = candidates.length;
		let loaded = 0;
		let firstCandidateLoaded = false;
		const partialSessions: SessionInfo[] = [];
		const results = await buildSessionInfosWithConcurrency(
			candidates,
			(info, index) => {
				loaded++;
				if (index === 0) firstCandidateLoaded = true;
				if (info) partialSessions.push(info);
				const publishPartial =
					firstCandidateLoaded &&
					(index === 0 || loaded % ALL_SESSION_LIST_PUBLISH_INTERVAL === 0 || loaded === totalFiles);
				progress?.(loaded, totalFiles, publishPartial ? sortSessionInfos([...partialSessions]) : undefined);
			},
			abortSignal,
		);

		return sortSessionInfos(results.filter((info): info is SessionInfo => info !== null));
	} catch (error) {
		abortSignal?.throwIfAborted();
		throw error;
	}
}
