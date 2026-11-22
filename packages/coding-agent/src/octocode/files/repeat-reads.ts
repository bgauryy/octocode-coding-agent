import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import type { FeatureContext, ToolResultEvent } from "../../core/features/index.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import { shortPath } from "../../utils/display-path.ts";
import { readerLocations, recordedLocalReads } from "../shared/local-reads.ts";
import { bashReads, soleWholeRead } from "./bash-reads.ts";
import { contextMessages, sessionCleared } from "./reads.ts";
import { type HeapRange, rangeText } from "../shared/heap-index.ts";
import { sessionHeap } from "../shared/session-heap.ts";

/**
 * Reads of a file (whole, or one line range a reader showed) that has not changed since the model last read the same
 * view, in the same context. The second one is answered with a short note naming the earlier result's heap handle
 * (`heap-index.ts`); a third (the model insisting), a changed file, another range, or an earlier result that was
 * cleared or compacted away gets the text as usual.
 * Bash prints (`cat FILE`, `bashReads`) count as unchanged by their stat (inode, size, modification and change time), a
 * reader's credited reads (`localReads`) by their SHA-256. A reader call repeated with the same arguments is the read dedupe's (`dedupe.ts`).
 */

/** One view of a file a result showed: whole or a line range, and the file's version then. */
interface View {
	file: string;
	range: HeapRange;
	version: string;
}

/** What one result showed: each view, and the one view that is the whole result and nothing else, if any. */
interface ResultReads {
	views: View[];
	sole?: View;
	reader: boolean;
}

const statVersion = (file: string): string | undefined => {
	const info = fs.statSync(file, { throwIfNoEntry: false });
	return info?.isFile() ? `stat:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` : undefined;
};

function readsOf(event: ToolResultEvent, cwd: string): ResultReads | undefined {
	const local = recordedLocalReads(event.details);
	if (local.length > 0) {
		const views = local.map((read) => ({
			file: canonicalPath(read.file),
			range: read.whole ? ("all" as const) : (read.lines ?? "all"),
			version: `sha:${read.sha256}`,
		}));
		// One location named, one view of it: the result is that view and nothing else.
		const located = readerLocations(event.input);
		const one = views.length === 1 && located.files.length === 1 && !located.unnamed;
		return { views, reader: true, ...(one ? { sole: views[0] } : {}) };
	}
	if (event.toolName !== "bash") return undefined;
	const { command, background } = event.input;
	if (typeof command !== "string" || background === true) return undefined;
	const details = asRecord(event.details);
	const cut = details.truncation !== undefined || details.fullOutputPath !== undefined;
	const views = bashReads(command, cwd, cut).flatMap((read) => {
		const file = canonicalPath(read.file);
		const version = read.whole ? statVersion(file) : undefined;
		return version ? [{ file, range: "all" as const, version }] : [];
	});
	const soleFile = cut ? undefined : soleWholeRead(command, cwd);
	const sole = soleFile ? views.find((view) => view.file === canonicalPath(soleFile)) : undefined;
	return { views, reader: false, ...(sole ? { sole } : {}) };
}

/** The call whose result still shows `id`'s text in the model's context (following a note to its target), or undefined. */
function shownIn(ctx: Pick<FeatureContext, "sessionManager">, id: string): string | undefined {
	const cleared = sessionCleared(ctx.sessionManager);
	const results = new Map<string, unknown>();
	for (const { message } of contextMessages(ctx))
		if (isRecord(message) && message.role === "toolResult") results.set(String(message.toolCallId), message.details);
	const seen = new Set<string>();
	for (let current: string | undefined = id; current !== undefined && !seen.has(current);) {
		seen.add(current);
		if (!results.has(current) || cleared.has(current)) return undefined;
		const target: unknown = asRecord(results.get(current)).unchangedOf;
		if (typeof target !== "string") return current;
		current = target;
	}
	return undefined;
}

/**
 * The repeated whole-read note, for the file guard's `tool_result` handler (`registerFileTool`) to return once it has
 * credited the read: after the read receipts (`read-receipts.ts`), whose `localReads` it reads, and before the read dedupe.
 * Returns the result's replacement, or undefined to leave it as it is. Each session's reads are kept by its manager.
 */
export function repeatReadNotes(): (
	event: ToolResultEvent,
	ctx: Pick<FeatureContext, "cwd" | "sessionManager">,
) => { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } | undefined {
	return (event, ctx) => {
		// A call another tool made never showed the model its text; without a session there is no context to point into.
		const heap = sessionHeap(ctx.sessionManager);
		if (event.isError || event.parentToolCallId || !heap) return undefined;
		const reads = readsOf(event, ctx.cwd);
		if (!reads || reads.views.length === 0) return undefined;
		const { index } = heap;
		const { sole } = reads;
		const earlier = sole && index.find(sole.file, sole.range);
		const sameCall = reads.reader && earlier?.input !== undefined && isDeepStrictEqual(earlier.input, event.input);
		const shown =
			sole && earlier && earlier.version === sole.version && !earlier.noted && !sameCall
				? shownIn(ctx, earlier.callId)
				: undefined;
		if (sole && earlier && shown) {
			earlier.noted = true;
			const where = shortPath(sole.file, ctx.cwd);
			return {
				content: [
					{
						type: "text" as const,
						text: renderPrompt("tools/file/repeat-read.md", {
							path: sole.range === "all" ? where : `${where} lines ${rangeText(sole.range)}`,
							handle: earlier.handle,
						}),
					},
				],
				details: { ...asRecord(event.details), unchangedOf: shown },
			};
		}
		for (const { file, range, version } of reads.views)
			index.record({
				path: file,
				range,
				version,
				callId: event.toolCallId,
				...(reads.reader ? { input: event.input } : {}),
			});
		return undefined;
	};
}
