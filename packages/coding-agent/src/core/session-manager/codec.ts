import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { RequestTrace } from "@octocodeai/octocode-ai";
import { restoreBashResult, storeBashResult } from "../tools/bash/stored-result.ts";
import { redactEntry } from "./codec-redact.ts";
import { SnapshotIndex } from "./codec-snapshots.ts";
import { isTraceDelta, TraceIndex } from "./codec-trace.ts";

/**
 * How entries are stored in a session file. In memory an entry is whole; on disk it leaves out what an earlier line of
 * the same file already holds:
 *
 * | Field | Stored as |
 * | --- | --- |
 * | an assistant message's `requestTrace` | the layers after the prefix it shares with an earlier trace (`codec-trace.ts`) |
 * | a system message's prompt text, sections and tool declarations, also inside a compaction | a hash of a part written earlier (`codec-snapshots.ts`) |
 * | a bash result's `details.output` and `structuredContent.output` | a span of its content text, or the path of its saved full output (`stored-result.ts`) |
 *
 * Credentials are removed from an entry's text as it is encoded (`codec-redact.ts`); the entry in memory is unchanged.
 *
 * References point only at earlier lines of the same file, so a lone file reads whole: copy, fork, export and archive
 * need nothing else. Files written before this format hold whole entries, which read unchanged. One codec follows one
 * file in order: `encode` an entry, write its line, then `observe` it; `decode` reads a line and observes it.
 */

type Record_ = Record<string, unknown>;

function messageOf(entry: Record_): Record_ | undefined {
	return entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
}

const isBashResult = (message: Record_ | undefined): message is Record_ =>
	message?.role === "toolResult" && message.toolName === "bash";

export class SessionCodec {
	private readonly traces = new TraceIndex();
	private readonly snapshots = new SnapshotIndex();

	/** The stored form of `entry` against the lines observed so far. Nothing is remembered until `observe`. */
	encode<T extends object>(entry: T): T {
		let stored = redactEntry(entry) as unknown as Record_;
		const message = messageOf(stored);
		if (message?.role === "assistant" && isRecord(message.requestTrace)) {
			const whole = message.requestTrace as unknown as RequestTrace;
			const trace = this.traces.encode(whole);
			if (trace !== whole) stored = { ...stored, message: { ...message, requestTrace: trace } };
		} else if (isBashResult(message)) {
			const result = storeBashResult(message);
			if (result !== message) stored = { ...stored, message: result };
		}
		return this.snapshots.encode(stored) as T;
	}

	/** Remember a whole entry the file now holds, so later lines can refer to it. */
	observe(entry: object): void {
		const record = entry as Record_;
		const message = messageOf(record);
		const trace = message?.role === "assistant" ? message.requestTrace : undefined;
		if (typeof record.id === "string" && isRecord(trace) && !isTraceDelta(trace)) {
			this.traces.add(record.id, trace as unknown as RequestTrace);
		}
		this.snapshots.add(record);
	}

	/** The whole entry a stored line holds, remembered for the lines after it. Anything else passes through. */
	decode<T>(record: T): T {
		if (!isRecord(record)) return record;
		let entry = this.snapshots.decode(record);
		const message = messageOf(entry);
		const trace = message?.role === "assistant" ? message.requestTrace : undefined;
		if (isTraceDelta(trace)) {
			// A base this file does not hold (a damaged file) leaves the delta as written.
			const whole = this.traces.decode(trace);
			if (whole) entry = { ...entry, message: { ...message, requestTrace: whole } };
		} else if (isRecord(trace) && Array.isArray(trace.layers)) {
			const shared = this.traces.share(trace as unknown as RequestTrace);
			entry = { ...entry, message: { ...message, requestTrace: shared } };
		} else if (isBashResult(message)) {
			const result = restoreBashResult(message);
			if (result !== message) entry = { ...entry, message: result };
		}
		const decoded = messageOf(entry)?.requestTrace;
		if (typeof entry.id === "string" && isRecord(decoded) && !isTraceDelta(decoded)) {
			this.traces.add(entry.id, decoded as unknown as RequestTrace);
		}
		return entry as T;
	}
}

/** The lines of a new file holding `entries` in order, and the codec that has observed them. */
export function encodeSessionLines(entries: readonly object[]): { lines: string[]; codec: SessionCodec } {
	const codec = new SessionCodec();
	const lines = entries.map((entry) => {
		const line = JSON.stringify(codec.encode(entry));
		codec.observe(entry);
		return line;
	});
	return { lines, codec };
}

/** The whole entries of a file's parsed lines, in file order. */
export function decodeSessionRecords<T>(records: readonly T[]): T[] {
	const codec = new SessionCodec();
	return records.map((record) => codec.decode(record));
}
