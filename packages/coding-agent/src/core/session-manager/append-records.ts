import { appendFileSync, statSync } from "node:fs";
import { getFileStamp } from "@octocodeai/octocode-common/paths";
import { scheduleSessionSync, sessionSyncFailed, sessionSyncRecovered } from "./deferred-sync.ts";
import { entryWritten } from "./entry-receipt.ts";
import { mirrorAppended } from "./mirror.ts";
import type { FileEnd } from "./session-tail.ts";
import type { SessionState } from "./state.ts";
import type { SessionEntry } from "./types.ts";

/** The file's size, or undefined when even that cannot be read. */
function fileSizeNow(file: string): number | undefined {
	try {
		return statSync(file).size;
	} catch {
		return undefined;
	}
}

function fileEnd(file: string): FileEnd {
	const stat = statSync(file, { bigint: true });
	return { size: Number(stat.size), mtime: String(stat.mtimeNs) };
}

/**
 * Append `pending` in order; a record leaves `unwritten` once it is written. The records written go to the database
 * mirror as one command, with the file's end before the first (`before`, when the caller read it under this lock) and
 * its stamp after the last, both under the lock: also when a later record fails without leaving part of its line. A
 * failure that left part of a line sends nothing; the mirror finds itself behind the file and catches up.
 */
export function appendRecords(
	state: SessionState,
	file: string,
	pending: readonly SessionEntry[],
	before?: FileEnd,
): void {
	if (pending.length === 0) return;
	const previous = before ?? fileEnd(file);
	const written: { entry: SessionEntry; line: string }[] = [];
	// The file holds bytes past the last written record: no stamp taken now describes exactly the records written.
	let partial = false;
	try {
		for (const entry of pending) {
			// Stored against the lines before it, and remembered for the lines after it only once it is written.
			const line = `${state.codec.line(entry)}\n`;
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
				const after = fileSizeNow(file);
				state.failedWrite = { from: state.fileSize, after, line, entry };
				partial = after !== state.fileSize;
				throw error;
			}
			state.fileSize = (state.fileSize ?? 0) + Buffer.byteLength(line);
			state.codec.observe(entry);
			const held = state.unwritten.indexOf(entry);
			if (held >= 0) state.unwritten.splice(held, 1);
			written.push({ entry, line });
			entryWritten(entry);
		}
	} finally {
		if (written.length > 0 && !partial) mirrorAppended(state, file, previous, written, getFileStamp(file));
	}
}
