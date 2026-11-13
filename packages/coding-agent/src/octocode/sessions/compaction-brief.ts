import { archivedSummary } from "../../core/compaction/checkpoint.ts";
import { clipWithMarker } from "../../core/compaction/inline.ts";
import { splitSummary } from "../../core/compaction/summary-view.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import type { CompactionEntry } from "../../core/session-manager.ts";
import { summaryMethodOf } from "../shared/summary-method.ts";
import { flatLine } from "./store.ts";
import { describeWork, unreportedWork } from "./work.ts";

const MAX_WORK = 8;
const WORK_CHARS = 400;
const REQUEST_CHARS = 1_200;

/** Bounded descriptions for the context compaction just freed; the complete starts remain in the session history. */
export function runningWorkBrief(entries: readonly unknown[], since: number, source?: string): string[] {
	const work = unreportedWork(entries, since);
	let shortened = false;
	const lines = work.slice(0, MAX_WORK).map((item) => {
		const full = describeWork(item, false);
		shortened ||= full.length > WORK_CHARS;
		return flatLine(clipWithMarker(full, WORK_CHARS));
	});
	const count = Math.max(0, work.length - MAX_WORK);
	if (count > 0 || (shortened && source))
		lines.push(renderInstruction("notices/compaction/work-more.md", { count, source }).trim());
	return lines;
}

/** Avoid duplicate verbatim requests only when that copy is actually present; otherwise restore a bounded excerpt. */
export function compactionRequestBrief(
	request: string,
	entry: Pick<CompactionEntry, "summary" | "details"> | undefined,
	source?: string,
): string | undefined {
	if (
		summaryMethodOf(entry?.details) !== undefined &&
		archivedSummary(entry?.details) === undefined &&
		typeof entry?.summary === "string" &&
		splitSummary(entry.summary).messages.includes(request)
	)
		return undefined;
	return request.length <= REQUEST_CHARS
		? renderInstruction("notices/compaction/latest-request.md", { request })
		: renderInstruction("notices/compaction/request-cut.md", {
				request: clipWithMarker(request, REQUEST_CHARS),
				source,
			});
}
