import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { atomicWriteFileSync } from "../../../common/src/atomic-file.ts";
import { PRIVATE_FILE_MODE } from "../../../common/src/file-mode.ts";
import { lockSyncWithRetry } from "../../../common/src/file-write-lock.ts";
import { getAgentDir, VERSION } from "../config.ts";
import type { Extension } from "./extensions/types.ts";
import { isSyntheticPath } from "./source-info.ts";

export interface CrashRecord {
	timestamp: string;
	version: string;
	kind: "uncaught_exception" | "fatal_error";
	message: string;
	stack: string | null;
	sessionFile: string | null;
	cwd: string;
	notified?: boolean;
}

const MAX_CRASH_RECORDS = 5;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function crashLogPath(agentDir = getAgentDir()): string {
	return join(agentDir, "crashes.json");
}

/** The stored records, and why the file could not be read when it exists but is unreadable or not a record list. */
function loadCrashLog(path: string): { records: CrashRecord[]; problem?: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [] };
		return { records: [], problem: errorMessage(error) };
	}
	try {
		const records: unknown = JSON.parse(text);
		if (!Array.isArray(records)) return { records: [], problem: "not a JSON array" };
		return {
			records: records.filter(
				(record): record is CrashRecord =>
					typeof record === "object" &&
					record !== null &&
					typeof (record as CrashRecord).timestamp === "string" &&
					typeof (record as CrashRecord).message === "string",
			),
		};
	} catch (error) {
		return { records: [], problem: errorMessage(error) };
	}
}

/** The recorded crashes. An unreadable log is reported as a record saying so, never as an empty history. */
export function readCrashLog(path = crashLogPath()): CrashRecord[] {
	const { records, problem } = loadCrashLog(path);
	if (!problem) return records;
	return [
		...records,
		{
			timestamp: new Date().toISOString(),
			version: VERSION,
			kind: "fatal_error",
			message: `The crash log ${path} could not be read (${problem}); earlier crash records may be lost.`,
			stack: null,
			sessionFile: null,
			cwd: dirname(path),
			notified: true,
		},
	];
}

/**
 * Read, change and replace the log under a cross-process lock, so concurrent crashing processes keep each other's
 * records and an interrupted write leaves the old file whole. An unreadable log is kept beside it as `.corrupt`.
 */
function updateCrashLog(path: string, update: (records: CrashRecord[]) => CrashRecord[]): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const release = lockSyncWithRetry(path, { lockfilePath: `${path}.lock` });
	try {
		const { records, problem } = loadCrashLog(path);
		if (problem) renameSync(path, `${path}.corrupt`);
		atomicWriteFileSync(path, `${JSON.stringify(update(records), null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
	} finally {
		release();
	}
}

type ExtensionStackMetadata = Pick<Extension, "path" | "resolvedPath" | "sourceInfo">;

function normalizeStackPath(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+$/u, "");
}

function stackContainsPath(stack: string, targetPath: string, includeDescendants: boolean): boolean {
	const target = normalizeStackPath(targetPath);
	if (!target || isSyntheticPath(target)) return false;
	const caseInsensitive = /^[a-z]:\//iu.test(target);
	const haystack = caseInsensitive ? stack.toLowerCase() : stack;
	const needle = caseInsensitive ? target.toLowerCase() : target;
	if (includeDescendants) return haystack.includes(`${needle}/`);

	let index = haystack.indexOf(needle);
	while (index !== -1) {
		const next = haystack[index + needle.length];
		if (next === undefined || next === ":" || next === ")" || /\s/u.test(next)) return true;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return false;
}

/** Find loaded extensions with source files in a stack trace. */
export function findExtensionStackMatches(
	stack: string | undefined,
	extensions: readonly ExtensionStackMetadata[],
): string[] {
	if (!stack) return [];
	const normalizedStack = stack
		.split("\n")
		.slice(1)
		.filter((line) => /^\s+at\s/u.test(line))
		.map((line) => {
			try {
				return decodeURI(line);
			} catch {
				return line;
			}
		})
		.join("\n")
		.replace(/\\/g, "/");
	const matches: string[] = [];
	const seen = new Set<string>();

	for (const extension of extensions) {
		const resolvedPath = normalizeStackPath(extension.resolvedPath);
		const singleFilePackage =
			extension.sourceInfo.origin === "package" &&
			!/^(?:npm:|git:|https?:\/\/|ssh:\/\/)/u.test(extension.sourceInfo.source) &&
			/\.[cm]?[jt]s$/u.test(extension.sourceInfo.source);
		const packageRoot =
			extension.sourceInfo.origin === "package" && !singleFilePackage && extension.sourceInfo.baseDir
				? extension.sourceInfo.baseDir
				: undefined;
		const slashIndex = resolvedPath.lastIndexOf("/");
		const directoryEntry = /\/index\.[cm]?[jt]s$/u.test(resolvedPath);
		const matched = packageRoot
			? stackContainsPath(normalizedStack, packageRoot, true)
			: directoryEntry && slashIndex !== -1
				? stackContainsPath(normalizedStack, resolvedPath.slice(0, slashIndex), true)
				: stackContainsPath(normalizedStack, resolvedPath, false);
		if (!matched) continue;

		const label =
			extension.sourceInfo.origin === "package" && extension.sourceInfo.source
				? extension.sourceInfo.source
				: extension.path;
		if (!seen.has(label)) {
			seen.add(label);
			matches.push(label);
		}
	}
	return matches;
}

/** Best-effort persistence for callers that are already crashing. */
export function recordCrash(
	crash: { kind: CrashRecord["kind"]; error: unknown; sessionFile?: string; cwd: string },
	path = crashLogPath(),
): CrashRecord | undefined {
	try {
		const { error } = crash;
		const record: CrashRecord = {
			timestamp: new Date().toISOString(),
			version: VERSION,
			kind: crash.kind,
			message: error instanceof Error ? error.message || error.name : String(error),
			stack: error instanceof Error && error.stack ? error.stack : null,
			sessionFile: crash.sessionFile ?? null,
			cwd: crash.cwd,
		};
		updateCrashLog(path, (records) => [...records, record].slice(-MAX_CRASH_RECORDS));
		return record;
	} catch {
		return undefined;
	}
}

/** Return the newest recent crash, marking pending records as announced. */
export function takeUnnotifiedCrash(path = crashLogPath(), now = Date.now()): CrashRecord | undefined {
	const records = readCrashLog(path);
	const crash = [...records]
		.reverse()
		.find((record) => !record.notified && now - Date.parse(record.timestamp) <= MAX_AGE);
	if (!crash) return undefined;
	try {
		updateCrashLog(path, (current) =>
			current.map((record) => (record.notified ? record : { ...record, notified: true })),
		);
	} catch {
		// Showing the notice again is harmless.
	}
	return crash;
}

export function clearCrashLog(path = crashLogPath()): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// The records can be attached again if cleanup fails.
	}
}
