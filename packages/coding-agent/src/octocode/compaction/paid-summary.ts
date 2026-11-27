import fs from "node:fs";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { CheckpointPersistenceError } from "../../core/compaction/checkpoint.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import { paidSummaryFile } from "../../core/session-manager/sidecars.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";

type Owner = Pick<ReadonlySessionManager, "getSessionFile">;

/** The model's summary of one input, kept so a failure after the paid call does not repeat it. */
export interface PaidSummary {
	key: string;
	result: CompactionResult;
	method: { method: string; reason?: string; early?: { requestedAt: string; waitedMs: number } };
}

/** The last paid summary of each session (by its session manager). */
const paid = new WeakMap<object, PaidSummary>();

function readSaved(sessionFile: string): PaidSummary | undefined {
	let text: string;
	try {
		text = fs.readFileSync(paidSummaryFile(sessionFile), "utf8");
	} catch (error) {
		// No file, or a session directory that does not exist: nothing was paid for.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
	let saved: unknown;
	try {
		saved = JSON.parse(text);
	} catch (error) {
		// A file cut short by a crash holds no summary to reuse; the next paid one replaces it.
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	const record = asRecord(saved);
	const result = asRecord(record?.result);
	if (typeof record?.key !== "string" || typeof result?.summary !== "string" || !asRecord(record.method))
		return undefined;
	return saved as PaidSummary;
}

/** The session's last paid summary: in memory, else the one saved before a restart. */
export function paidSummaryOf(sessionManager: Owner): PaidSummary | undefined {
	const known = paid.get(sessionManager);
	if (known) return known;
	const sessionFile = sessionManager.getSessionFile();
	const saved = sessionFile ? readSaved(sessionFile) : undefined;
	if (saved) paid.set(sessionManager, saved);
	return saved;
}

/** Keeps a paid summary until the same input is summarized again, in memory and (for a saved session) on disk. */
export function keepPaidSummary(sessionManager: Owner, summary: PaidSummary): void {
	paid.set(sessionManager, summary);
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) return;
	try {
		atomicWriteFileSync(paidSummaryFile(sessionFile), JSON.stringify(summary), { mode: 0o600 });
	} catch (error) {
		// Reported like any session file that cannot be written; the summary stays in memory for the next attempt.
		throw new CheckpointPersistenceError(`Cannot persist the paid summary: ${String(error)}`);
	}
}
