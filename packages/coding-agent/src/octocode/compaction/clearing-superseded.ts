import type { MessageRef } from "../files/reads.ts";
import { type LineRange, readView } from "../files/coverage.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { readPaths } from "../shared/home.ts";

/**
 * The results of `read` calls that a newer read of the same file shows again: the model holds the newer text, so
 * the older one adds nothing the call could not return. A read is superseded by a later read that is whole, or whose
 * lines include all of its lines; a whole read is never superseded by a range. Reads of other tools are not judged:
 * their arguments have no common spelling.
 */

/** What one earlier read showed: `lines` is undefined for a whole file or for a part whose lines are unknown. */
interface EarlierRead {
	id: string;
	whole: boolean;
	lines?: LineRange;
}

function covers(newer: { whole: boolean; lines?: LineRange }, older: EarlierRead): boolean {
	if (newer.whole) return true;
	return !older.whole && older.lines !== undefined && newer.lines !== undefined
		? newer.lines[0] <= older.lines[0] && newer.lines[1] >= older.lines[1]
		: false;
}

/** The tool call ids of the superseded reads in `messages`; `cleared` results (shown as placeholders) supersede nothing. */
export function supersededReads(
	messages: readonly MessageRef[],
	calls: ReadonlyMap<string, Record<string, unknown>>,
	cwd: string,
	cleared: ReadonlyMap<string, string>,
): Set<string> {
	const earlier = new Map<string, EarlierRead[]>();
	const superseded = new Set<string>();
	for (const { message } of messages) {
		if (
			!isRecord(message) ||
			message.role !== "toolResult" ||
			message.toolName !== "read" ||
			message.isError === true ||
			typeof message.toolCallId !== "string" ||
			cleared.has(message.toolCallId) ||
			(isRecord(message.details) && message.details.unchangedOf !== undefined)
		)
			continue;
		const input = calls.get(message.toolCallId);
		const file = input ? readPaths("read", input, cwd)[0] : undefined;
		const view = input ? readView("read", input, message.content, message.details) : undefined;
		if (file === undefined || view === undefined) continue;
		const seen = (earlier.get(file) ?? []).filter((read) => {
			if (!covers(view, read)) return true;
			superseded.add(read.id);
			return false;
		});
		seen.push({ id: message.toolCallId, whole: view.whole, ...(view.lines ? { lines: view.lines } : {}) });
		earlier.set(file, seen);
	}
	return superseded;
}
