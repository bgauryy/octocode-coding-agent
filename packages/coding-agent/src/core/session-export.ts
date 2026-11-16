import { resolvePath } from "@octocodeai/octocode-common/paths";
import { writeSessionExport } from "./export-target.ts";
import { encodeSessionLines } from "./session-manager/codec.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionManager } from "./session-manager.ts";

type TrailingEntries = (parentId: string | null, timestamp: string) => readonly object[];

/** Serialize the current branch and optional export-only entries as JSONL. */
export function serializeSessionBranch(
	sessionManager: SessionManager,
	createTrailingEntries?: TrailingEntries,
): string {
	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp,
		cwd: sessionManager.getCwd(),
	};
	const entries: object[] = [header];
	let parentId: string | null = null;
	for (const entry of sessionManager.getBranch()) {
		entries.push({ ...entry, parentId });
		parentId = entry.id;
	}
	entries.push(...(createTrailingEntries?.(parentId, timestamp) ?? []));
	// Stored as a session file stores them (`session-manager/codec.ts`): the export reads back on its own.
	return `${encodeSessionLines(entries).lines.join("\n")}\n`;
}

/** Write the current session branch and optional export-only entries as JSONL. */
export function exportSessionToJsonl(
	sessionManager: SessionManager,
	outputPath?: string,
	createTrailingEntries?: TrailingEntries,
): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	writeSessionExport(
		filePath,
		serializeSessionBranch(sessionManager, createTrailingEntries),
		sessionManager.getSessionFile(),
	);
	return filePath;
}
