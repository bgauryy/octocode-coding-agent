import fs from "node:fs";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { parseJsonlLine } from "../../../../../common/src/jsonl.ts";
import type { ReadonlySessionManager } from "../../../core/session-manager.ts";
import { EntryCursor } from "../../shared/entry-cursor.ts";
import { AGENT_RESULT_TYPE } from "../../shared/messages.ts";

export type ReceiptSession = Pick<ReadonlySessionManager, "getEntries" | "getSessionFile"> &
	Partial<Pick<ReadonlySessionManager, "getEntryCount" | "getEntry" | "getLeafId" | "getHeader">>;

/** The report ids a parent session has recorded: the session's entries, rather than send-call returns, acknowledge a report. */
export class ReportReceipts {
	/** Ids recorded in the parent session. */
	private readonly known = new Set<string>();
	/** The transcript file being scanned for receipts, and how many bytes of it end in a complete line already read. */
	private scanned: { file: string; offset: number } | undefined;
	private readonly entries = new EntryCursor();
	private scannedEntryCount: number | undefined;

	has(id: string): boolean {
		return this.known.has(id);
	}

	scan(session: ReceiptSession): void {
		const file = session.getSessionFile();
		if (file) this.scanFile(file);
		// The session writer buffers entries in memory until the first assistant message creates the transcript; after
		// that every entry is appended as it is added. So with a transcript path, in-memory entries are a durable receipt
		// only once the file exists. A session with no transcript path has nothing more durable than its entries.
		if (!file || fs.existsSync(file)) this.scanEntries(session);
	}

	/** Receipts (report ids) the transcript file gained since the last scan: only the new complete lines are read. */
	private scanFile(file: string): void {
		try {
			const size = fs.statSync(file).size;
			if (this.scanned?.file !== file || size < this.scanned.offset) this.scanned = { file, offset: 0 };
			const from = this.scanned.offset;
			if (size === from) return;
			const buffer = Buffer.alloc(size - from);
			const fd = fs.openSync(file, "r");
			let read = 0;
			try {
				read = fs.readSync(fd, buffer, 0, buffer.length, from);
			} finally {
				fs.closeSync(fd);
			}
			const end = buffer.subarray(0, read).lastIndexOf(0x0a) + 1;
			this.scanned.offset = from + end;
			for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
				if (!line.includes(AGENT_RESULT_TYPE)) continue;
				const parsed = parseJsonlLine(line);
				// A malformed line is not a receipt.
				if (parsed?.ok) this.receipt(parsed.value);
			}
		} catch {
			// A not-yet-created or unreadable transcript is not a receipt.
		}
	}

	private receipt(entry: unknown): void {
		if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== AGENT_RESULT_TYPE) return;
		if (!isRecord(entry.details)) return;
		const id = entry.details.reportId;
		if (typeof id === "string") this.known.add(id);
	}

	/**
	 * Entries are immutable and append-only: only those appended since the last scan are read (`EntryCursor`), and none
	 * while the count is unchanged.
	 */
	private scanEntries(session: ReceiptSession): void {
		const count = session.getEntryCount?.();
		if (count !== undefined && count === this.scannedEntryCount) return;
		for (const entry of this.entries.next(session).entries) this.receipt(entry);
		this.scannedEntryCount = count;
	}
}
