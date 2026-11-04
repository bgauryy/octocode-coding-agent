import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { transcripts } from "../../../../db/src/api.ts";
import { defaultSessionDirectories, legacySessionDirectoryPath } from "./directories.ts";
import { sharedAgentDb } from "../../config/database.ts";
import { ensureWorkspaceStateDir, workspaceIdentity, workspaceStateDir } from "../../config/workspace.ts";
import { atomicWriteFileSync } from "../../../../common/src/atomic-file.ts";
import { normalizePath, resolvePath } from "../../../../common/src/paths.ts";
import { forkHint } from "./shared-file.ts";
import {
	assertValidSessionId,
	createSessionHeader,
	createSessionId,
	getSessionFilePath,
	migrateToCurrentVersion,
	parseSessionEntryLine,
} from "./entries.ts";
import type { FileEntry, NewSessionOptions, SessionHeader } from "./types.ts";

/** Offset just past the last newline of `fd` (0 when there is none), reading backwards in blocks. */
export function endOfLastRecord(fd: number, size: number): number {
	const block = Buffer.alloc(64 * 1024);
	for (let end = size; end > 0;) {
		const start = Math.max(0, end - block.length);
		const read = readSync(fd, block, 0, end - start, start);
		const at = block.subarray(0, read).lastIndexOf(10);
		if (at >= 0) return start + at + 1;
		end = start;
	}
	return 0;
}

/**
 * Throws unless the file ends with a whole record. Returns true when that record lacks only its newline (a hand edit,
 * or a writer that stopped just before it); a caller about to append, holding the session lock, writes the newline
 * first. `loadEntriesFromFile` keeps such a record and never writes the file itself.
 */
export function assertCompleteSessionTail(file: string): boolean {
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size;
		const last = Buffer.alloc(1);
		if (size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 10) return false;
		const start = endOfLastRecord(fd, size);
		const tail = Buffer.alloc(size - start);
		if (size > 0 && readSync(fd, tail, 0, tail.length, start) === tail.length) {
			if (parseSessionEntryLine(tail.toString("utf8"))) return true;
		}
		throw new Error(`Session has an incomplete final record. ${forkHint(file)}`);
	} finally {
		closeSync(fd);
	}
}

/** Whether `file` ends in part of a record, so it cannot be appended to. A read-only check for a UI to offer a fork. */
export function hasTornTail(file: string): boolean {
	try {
		if (statSync(file).size === 0) return false;
		assertCompleteSessionTail(file);
		return false;
	} catch {
		return existsSync(file);
	}
}

/** Default transcript directory shared by all working directories in this checkout. */
export function getDefaultSessionDirPath(cwd: string): string {
	return workspaceStateDir(cwd, "sessions");
}

export function getDefaultSessionDir(cwd: string): string {
	return ensureWorkspaceStateDir(cwd, "sessions");
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
/** Bound synchronous header discovery while allowing large cwd and custom metadata fields. */
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

class SessionHeaderScanLimitError extends Error {
	constructor(filePath: string) {
		super(`Session header exceeds ${MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: ${filePath}`);
		this.name = "SessionHeaderScanLimitError";
	}
}

/** Exported for testing */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	let pending = "";
	const fd = openSync(resolvedFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex));
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		const finalEntry = parseSessionEntryLine(pending);
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return [];
	}
	return entries;
}

/**
 * Inspect a physical line while searching for the first parsed session entry.
 * Blank and malformed lines are skipped to match loadEntriesFromFile().
 * Returns undefined to keep scanning, null for a parsed non-header entry, or the header.
 */
function parseSessionHeaderCandidate(line: string): SessionHeader | null | undefined {
	if (!line.trim()) return undefined;
	const entry = parseSessionEntryLine(line);
	if (!entry) return undefined;
	if (entry.type !== "session" || typeof (entry as { id?: unknown }).id !== "string") return null;
	return entry;
}

function readSessionHeader(filePath: string): SessionHeader | null {
	const fd = openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
		const lineChunks: string[] = [];
		let scannedBytes = 0;

		while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
			const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) {
				lineChunks.push(decoder.end());
				return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
			}
			scannedBytes += bytesRead;

			const chunk = decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = chunk.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				lineChunks.push(chunk.slice(lineStart, newlineIndex));
				const header = parseSessionHeaderCandidate(lineChunks.join(""));
				if (header !== undefined) return header;
				lineChunks.length = 0;
				lineStart = newlineIndex + 1;
				newlineIndex = chunk.indexOf("\n", lineStart);
			}
			lineChunks.push(chunk.slice(lineStart));
		}

		// Probe for EOF so a final header without a newline is allowed when it ends
		// exactly at the scan limit. Any additional byte exceeds the bounded scan.
		const probe = Buffer.allocUnsafe(1);
		if (readSync(fd, probe, 0, probe.length, null) === 0) {
			lineChunks.push(decoder.end());
			return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
		}
		throw new SessionHeaderScanLimitError(filePath);
	} finally {
		closeSync(fd);
	}
}

export function readSessionHeaderForDiscovery(filePath: string): SessionHeader | null {
	try {
		return readSessionHeader(filePath);
	} catch {
		// Discovery is best-effort: unreadable or oversized files are not sessions,
		// and one corrupt file must not prevent other sessions from being found.
		return null;
	}
}

export function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

export function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}

/** Exported for testing */
export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
	try {
		const files = readdirSync(resolvedSessionDir)
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => join(resolvedSessionDir, file))
			.flatMap((path) => {
				try {
					const stats = statSync(path);
					return stats.isFile() ? [{ path, mtime: stats.mtimeMs }] : [];
				} catch {
					return [];
				}
			})
			.sort((a, b) => b.mtime - a.mtime);

		for (const { path } of files) {
			const header = readSessionHeaderForDiscovery(path);
			if (header && (!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd))) return path;
		}
		return null;
	} catch {
		// A directory that cannot be read has no discoverable recent session.
		return null;
	}
}

/**
 * The newest session of `cwd`: in a custom `sessionDir` (only sessions whose header names `cwd`), else across its
 * default transcript folders (workspace and legacy), or null.
 */
export function findMostRecentForCwd(cwd: string, sessionDir?: string): string | null {
	if (sessionDir && normalizePath(sessionDir) !== getDefaultSessionDirPath(cwd))
		return findMostRecentSession(sessionDir, cwd);
	let best: { path: string; mtime: number } | undefined;
	for (const { dir, filterCwd } of defaultSessionDirectories(cwd)) {
		const path = findMostRecentSession(dir, filterCwd ? cwd : undefined);
		if (!path) continue;
		let mtime: number;
		try {
			mtime = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		if (!best || mtime > best.mtime) best = { path, mtime };
	}
	return best?.path ?? null;
}

/** Create a session file that must not exist yet, writing every entry and syncing before close. */
export function writeNewSessionFile(sessionFile: string, fileEntries: readonly FileEntry[]): void {
	const fd = openSync(sessionFile, "wx", 0o600);
	try {
		for (const e of fileEntries) {
			writeFileSync(fd, `${JSON.stringify(e)}\n`);
		}
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Resolved arguments for opening a specific session file. */
export interface OpenedSessionTarget {
	cwd: string;
	dir: string;
	resolvedPath: string;
	preloadedFileEntries: FileEntry[] | undefined;
}

/** Resolve the cwd and session directory used by `SessionManager.open()`. */
export function resolveOpenedSession(path: string, sessionDir?: string, cwdOverride?: string): OpenedSessionTarget {
	const resolvedPath = resolvePath(path);
	let header: SessionHeader | null = null;
	let preloadedFileEntries: FileEntry[] | undefined;
	if (cwdOverride === undefined && existsSync(resolvedPath)) {
		try {
			header = readSessionHeader(resolvedPath);
		} catch (error) {
			if (!(error instanceof SessionHeaderScanLimitError)) throw error;
			// The bounded scan is only a discovery optimization. A full load remains
			// authoritative for legacy files with very large headers or prefixes.
			preloadedFileEntries = loadEntriesFromFile(resolvedPath);
			const firstEntry = preloadedFileEntries[0];
			header = firstEntry?.type === "session" ? firstEntry : null;
		}
	}
	const cwd = cwdOverride ?? (header ? getSessionHeaderCwd(header) : undefined) ?? process.cwd();
	// Without a sessionDir the file's folder is kept, except the legacy per-cwd folder: new sessions go to the workspace.
	const parent = resolve(resolvedPath, "..");
	const legacy = parent === legacySessionDirectoryPath(cwd);
	const dir = sessionDir ? normalizePath(sessionDir) : legacy ? getDefaultSessionDirPath(cwd) : parent;
	return { cwd, dir, resolvedPath, preloadedFileEntries };
}

/**
 * Write a forked copy of a session file into the target project's session directory.
 * Returns the arguments `SessionManager.forkFrom()` opens the new session with.
 */
export function forkSessionFile(
	sourcePath: string | { storedId: string },
	targetCwd: string,
	sessionDir?: string,
	options?: NewSessionOptions,
): { cwd: string; dir: string; sessionFile: string; sourceFile: string; sourceId: string } {
	let resolvedSourcePath: string;
	let sourceEntries: FileEntry[];
	if (typeof sourcePath === "string") {
		resolvedSourcePath = resolvePath(sourcePath);
		sourceEntries = loadEntriesFromFile(resolvedSourcePath);
	} else {
		const agent = sharedAgentDb();
		const old = transcripts.stamp(agent.db, sourcePath.storedId);
		if (!old) throw new Error(`No saved transcript for session ${sourcePath.storedId}`);
		resolvedSourcePath = old.file;
		// The file is the record: its database copy is stale exactly when a mirror rebuild failed. The copy serves when
		// the file is gone, or no longer holds this session.
		const onDisk = loadEntriesFromFile(old.file);
		sourceEntries =
			onDisk[0]?.type === "session" && onDisk[0].id === sourcePath.storedId
				? onDisk
				: transcripts.records(agent.db, sourcePath.storedId).map((line) => JSON.parse(line) as FileEntry);
	}
	const resolvedTargetCwd = resolvePath(targetCwd);
	if (sourceEntries.length === 0) {
		throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
	}

	const sourceHeader = sourceEntries.find((e) => e.type === "session");
	if (!sourceHeader) {
		throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);
	}
	migrateToCurrentVersion(sourceEntries);

	// The fork is new work in targetCwd even when its caller chooses a separate JSONL directory.
	if (sessionDir && statSync(resolvedTargetCwd, { throwIfNoEntry: false })?.isDirectory())
		workspaceIdentity(resolvedTargetCwd);
	const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	// Create new session file with new ID but forked content
	if (options?.id !== undefined) {
		assertValidSessionId(options.id);
	}
	const newSessionId = options?.id ?? createSessionId();
	const timestamp = new Date().toISOString();
	const newSessionFile = getSessionFilePath(dir, timestamp, newSessionId);

	// A new header pointing to the source as parent, with the target cwd, then every non-header entry of the source.
	// The copy is written whole to a temporary sibling and renamed into place, so a failure leaves no partial fork.
	const newHeader = createSessionHeader(newSessionId, timestamp, resolvedTargetCwd, resolvedSourcePath);
	if (typeof sourcePath !== "string") newHeader.parentSessionId = sourcePath.storedId;
	const content = [newHeader, ...sourceEntries.filter((entry) => entry.type !== "session")]
		.map((entry) => `${JSON.stringify(entry)}\n`)
		.join("");
	if (existsSync(newSessionFile)) throw new Error(`Cannot fork: session file already exists: ${newSessionFile}`);
	atomicWriteFileSync(newSessionFile, content, { mode: 0o600 });

	return {
		cwd: resolvedTargetCwd,
		dir,
		sessionFile: newSessionFile,
		sourceFile: resolvedSourcePath,
		sourceId: sourceHeader.id,
	};
}
