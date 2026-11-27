import { uuidv7 } from "@octocodeai/octocode-ai";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { jsonlLines, parseJsonlLine } from "@octocodeai/octocode-common/jsonl";
import { CURRENT_SESSION_VERSION, type FileEntry, type SessionHeader } from "./types.ts";

export function createSessionId(): string {
	return uuidv7();
}

export function assertValidSessionId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
export function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// Fallback to full UUID if somehow we have collisions
	return randomUUID();
}

/**
 * Refuses a session file of another format version. Octocode does not convert session files: one written by another
 * version is left as it is, and the caller reports why it cannot be opened.
 */
export function assertCurrentSessionVersion(header: SessionHeader, file?: string): void {
	if (header.version === CURRENT_SESSION_VERSION) return;
	const found = header.version === undefined ? "no version" : `version ${header.version}`;
	throw new Error(
		`Session file ${file ?? header.id} has ${found}; this Octocode reads version ${CURRENT_SESSION_VERSION} only. The file is left as it is.`,
	);
}

/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	// A malformed line is skipped: a torn write must not make the rest of the session unreadable.
	for (const line of jsonlLines(content)) if (line.ok && line.value) entries.push(line.value as FileEntry);
	return entries;
}

/** One session-file line as an entry, or null for a blank or malformed line (a torn write is skipped, not fatal). */
export function parseSessionEntryLine(line: string): FileEntry | null {
	const parsed = parseJsonlLine(line);
	return parsed?.ok ? (parsed.value as FileEntry | null) : null;
}

/** Build a current-version session header. */
export function createSessionHeader(
	id: string,
	timestamp: string,
	cwd: string,
	parentSession: string | undefined,
): SessionHeader {
	return { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd, parentSession };
}

export function getSessionFilePath(dir: string, timestamp: string, id: string): string {
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	return join(dir, `${fileTimestamp}_${id}.jsonl`);
}
