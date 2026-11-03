import { uuidv7 } from "@octocodeai/octocode-ai";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { jsonlLines, parseJsonlLine } from "../../../../common/src/jsonl.ts";
import { CURRENT_SESSION_VERSION, type CompactionEntry, type FileEntry, type SessionHeader } from "./types.ts";

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

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		ids.add(entry.id);
		entry.parentId = prevId;
		prevId = entry.id;

		// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		// Update message entries with hookMessage role
		if (entry.type === "message") {
			const msgEntry = entry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
export function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session");
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);

	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
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

/** Session file path for a session created at an ISO timestamp. */
export function getSessionFilePath(dir: string, timestamp: string, id: string): string {
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	return join(dir, `${fileTimestamp}_${id}.jsonl`);
}
