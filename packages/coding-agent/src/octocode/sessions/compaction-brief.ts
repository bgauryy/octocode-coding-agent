import { archivedSummary } from "../../core/compaction/checkpoint.ts";
import { clipWithMarker } from "../../core/compaction/inline.ts";
import { splitSummary } from "../../core/compaction/summary-view.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import type { CompactionEntry } from "../../core/session-manager.ts";
import { summaryMethodOf } from "../shared/summary-method.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { contentText } from "../shared/util.ts";
import { flatLine, shownLine } from "./store.ts";
import { describeWork, unreportedWork } from "./work.ts";

const MAX_WORK = 8;
/** Characters kept of a job's command or a subagent's goal; its id, reason, log and folder stay whole. */
const LABEL_CHARS = 400;
const REQUEST_CHARS = 1_200;
/** Characters kept of the last reply: its lead says what was done and what comes next. */
const REPLY_CHARS = 400;

/** Bounded descriptions for the context compaction just freed; the complete starts remain in the session history. */
export function runningWorkBrief(entries: readonly unknown[], since: number, source?: string): string[] {
	const work = unreportedWork(entries, since);
	let shortened = false;
	const lines = work.slice(0, MAX_WORK).map((item) => {
		shortened ||= item.label.length > LABEL_CHARS;
		const label = flatLine(clipWithMarker(item.label, LABEL_CHARS, source !== undefined));
		return describeWork({ ...item, label }, false);
	});
	const count = Math.max(0, work.length - MAX_WORK);
	if (count > 0 || (shortened && source))
		lines.push(renderPrompt("notices/compaction/work-more.md", { count, source }).trim());
	return lines;
}

/**
 * Whether the compaction kept `branch[index]` whole: it lies at or after the compaction's first kept entry, so the
 * model still reads it in the retained tail. False when the first kept entry is not on the branch.
 */
export function keptAfterCompaction(
	branch: readonly unknown[],
	index: number,
	entry: Pick<CompactionEntry, "firstKeptEntryId"> | undefined,
): boolean {
	const firstKept = entry?.firstKeptEntryId;
	if (!firstKept || index < 0) return false;
	const start = branch.findIndex((item) => (item as { id?: unknown } | null)?.id === firstKept);
	return start >= 0 && index >= start;
}

/**
 * The lead of the last assistant reply with text, as one bounded line, so the next model knows what it last told the
 * user. Undefined when there is none or the compaction kept that reply in the retained tail.
 */
export function lastReplyBrief(
	branch: readonly unknown[],
	entry: Pick<CompactionEntry, "firstKeptEntryId"> | undefined,
): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const item = branch[index];
		if (!isRecord(item) || item.type !== "message" || !isRecord(item.message)) continue;
		if (item.message.role !== "assistant") continue;
		const text = contentText(item.message.content).trim();
		if (!text) continue;
		if (keptAfterCompaction(branch, index, entry)) return undefined;
		const lead = text.split(/\n\s*\n/)[0];
		return renderPrompt("notices/compaction/last-reply.md", { reply: shownLine(lead, REPLY_CHARS) }).trim();
	}
	return undefined;
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
		? renderPrompt("notices/compaction/latest-request.md", { request })
		: renderPrompt("notices/compaction/request-cut.md", {
				request: clipWithMarker(request, REQUEST_CHARS, source !== undefined),
				source,
			});
}
