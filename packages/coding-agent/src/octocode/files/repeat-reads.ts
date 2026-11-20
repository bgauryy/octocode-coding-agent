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

/**
 * Whole reads of a file that has not changed since the model last read it whole, in the same context. The second one is
 * answered with a short note that points at the earlier result and asks for a range or a symbol instead; a third (the
 * model insisting), a changed file, or an earlier result that was cleared or compacted away gets the text as usual.
 * Bash prints (`cat FILE`, `bashReads`) count as unchanged by their stat (inode, size, modification and change time), a
 * reader's credited reads (`localReads`) by their SHA-256. A reader call repeated with the same arguments is the read dedupe's (`dedupe.ts`).
 */

/** The latest whole read of one file: the call whose result shows it, and the file's version then. */
interface WholeRead {
	id: string;
	version: string;
	/** A reader's call arguments; absent for bash. */
	input?: Record<string, unknown>;
	/** This version was answered with the note once: the next whole read of it gets the text. */
	noted?: boolean;
}

/** What one result read whole: each file with its version, and the one file it printed and nothing else, if any. */
interface ResultReads {
	whole: Array<{ file: string; version: string }>;
	sole?: string;
	reader: boolean;
}

const statVersion = (file: string): string | undefined => {
	const info = fs.statSync(file, { throwIfNoEntry: false });
	return info?.isFile() ? `stat:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` : undefined;
};

function readsOf(event: ToolResultEvent, cwd: string): ResultReads | undefined {
	const local = recordedLocalReads(event.details);
	if (local.length > 0) {
		const whole = local
			.filter((read) => read.whole)
			.map((read) => ({ file: canonicalPath(read.file), version: `sha:${read.sha256}` }));
		// One location named, one file read whole: the result is that file and nothing else.
		const located = readerLocations(event.input);
		const one = local.length === 1 && whole.length === 1 && located.files.length === 1 && !located.unnamed;
		return { whole, reader: true, ...(one ? { sole: whole[0].file } : {}) };
	}
	if (event.toolName !== "bash") return undefined;
	const { command, background } = event.input;
	if (typeof command !== "string" || background === true) return undefined;
	const details = asRecord(event.details);
	const cut = details.truncation !== undefined || details.fullOutputPath !== undefined;
	const whole = bashReads(command, cwd, cut).flatMap((read) => {
		const file = canonicalPath(read.file);
		const version = read.whole ? statVersion(file) : undefined;
		return version ? [{ file, version }] : [];
	});
	const sole = cut ? undefined : soleWholeRead(command, cwd);
	return { whole, reader: false, ...(sole ? { sole: canonicalPath(sole) } : {}) };
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
	const sessions = new WeakMap<object, Map<string, WholeRead>>();
	return (event, ctx) => {
		// A call another tool made never showed the model its text; without a session there is no context to point into.
		const owner = ctx.sessionManager as object | undefined;
		if (event.isError || event.parentToolCallId || !owner) return undefined;
		const reads = readsOf(event, ctx.cwd);
		if (!reads || reads.whole.length === 0) return undefined;
		let latest = sessions.get(owner);
		if (!latest) sessions.set(owner, (latest = new Map()));
		const sole = reads.sole === undefined ? undefined : reads.whole.find((read) => read.file === reads.sole);
		const earlier = sole && latest.get(sole.file);
		const sameCall = reads.reader && earlier?.input !== undefined && isDeepStrictEqual(earlier.input, event.input);
		const shown =
			sole && earlier && earlier.version === sole.version && !earlier.noted && !sameCall
				? shownIn(ctx, earlier.id)
				: undefined;
		if (sole && earlier && shown) {
			earlier.noted = true;
			return {
				content: [
					{
						type: "text" as const,
						text: renderPrompt("tools/file/repeat-read.md", { path: shortPath(sole.file, ctx.cwd) }),
					},
				],
				details: { ...asRecord(event.details), unchangedOf: shown },
			};
		}
		for (const { file, version } of reads.whole)
			latest.set(file, { id: event.toolCallId, version, ...(reads.reader ? { input: event.input } : {}) });
		return undefined;
	};
}
