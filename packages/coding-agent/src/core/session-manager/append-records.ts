import { appendFileSync, statSync } from "node:fs";
import { getFileStamp } from "../../../../common/src/paths.ts";
import { scheduleSessionSync, sessionSyncFailed, sessionSyncRecovered } from "./deferred-sync.ts";
import { mirrorAppended } from "./mirror.ts";
import type { SessionState } from "./state.ts";
import { assertCompleteSessionTail } from "./storage.ts";
import type { SessionEntry } from "./types.ts";

/** The file's size, or undefined when even that cannot be read. */
function fileSizeNow(file: string): number | undefined {
	try {
		return statSync(file).size;
	} catch {
		return undefined;
	}
}

/**
 * Append `pending` in order; a record leaves `unwritten` once it is written. The records written go to the database
 * mirror as one command, with the file's stamp before the first and after the last, both taken here under the lock: also
 * when a later record fails.
 */
export function appendRecords(state: SessionState, file: string, pending: readonly SessionEntry[]): void {
	if (pending.length === 0) return;
	const before = statSync(file, { bigint: true });
	const previous = { size: Number(before.size), mtime: String(before.mtimeNs) };
	const written: { entry: SessionEntry; line: string }[] = [];
	let stamp: ReturnType<typeof getFileStamp> | undefined;
	try {
		if (assertCompleteSessionTail(file)) {
			appendFileSync(file, "\n");
			state.fileSize = (state.fileSize ?? 0) + 1;
		}
		for (const entry of pending) {
			// Stored against the lines before it, and remembered for the lines after it only once it is written.
			const line = `${JSON.stringify(state.codec.encode(entry))}\n`;
			try {
				if (sessionSyncFailed(file)) {
					// The last deferred sync failed: flush here, so the error is raised by this append and handled below.
					appendFileSync(file, line, { flush: true });
					sessionSyncRecovered(file);
				} else {
					// Written now, synced to the drive off the main thread (`deferred-sync.ts`).
					appendFileSync(file, line);
					scheduleSessionSync(file);
				}
			} catch (error) {
				state.failedWrite = { from: state.fileSize, after: fileSizeNow(file), line, entry };
				throw error;
			}
			state.fileSize = (state.fileSize ?? 0) + Buffer.byteLength(line);
			state.codec.observe(entry);
			const held = state.unwritten.indexOf(entry);
			if (held >= 0) state.unwritten.splice(held, 1);
			written.push({ entry, line });
			stamp = getFileStamp(file);
		}
	} finally {
		if (stamp) mirrorAppended(state, file, previous, written, stamp);
	}
}
