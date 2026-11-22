import { AgentToolExecutionError } from "@octocodeai/octocode-agent-core";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { contentText, textResult } from "./util.ts";

/** What a tool entry returns: its content, and details a caller may read. */
export type EntryResult = { content: unknown; details?: unknown };
export type BatchResult = ReturnType<typeof textResult>;
export type EntryOutcome = { ok: boolean; text: string };

export interface BatchOutcome {
	index: number;
	status: "applied" | "refused" | "unknown";
	text: string;
}

interface BatchAbortReceipt {
	status: "aborted";
	/** The batch that was cut short: a backlog `add` or `edit`, or another tool's write batch. */
	operation: string;
	requested: number;
	applied: number;
	refused: number;
	uncertain: number;
	notAttempted: number;
	outcomes: BatchOutcome[];
}

/** Committed entries cannot be rolled back by cancelling the remaining batch. Preserve their receipt for the loop. */
export class BatchAbortedError extends AgentToolExecutionError<BatchAbortReceipt> {
	constructor(operation: string, requested: number, outcomes: BatchOutcome[]) {
		const count = (status: BatchOutcome["status"]) => outcomes.filter((row) => row.status === status).length;
		const details: BatchAbortReceipt = {
			status: "aborted",
			operation,
			requested,
			outcomes,
			applied: count("applied"),
			refused: count("refused"),
			uncertain: count("unknown"),
			notAttempted: requested - outcomes.length,
		};
		const text = [
			`Cancelled ${operation} batch: ${details.applied} applied; ${details.refused} refused; ${details.uncertain} uncertain; ${details.notAttempted} not attempted.`,
			...outcomes.map((row) => `${row.index + 1}. ${row.text}`),
			"Earlier applied entries remain committed. Inspect the listed items before retrying; an uncertain entry may already have applied.",
		].join("\n");
		super(text, { content: [{ type: "text", text }], details, isError: true });
		this.name = "AbortError";
	}
}

/** Runs one entry: its reply text, or a refusal row labelled `label`. A cancel propagates. */
export async function attemptWrite(
	label: string,
	run: () => EntryResult | Promise<EntryResult>,
	signal?: AbortSignal,
): Promise<EntryOutcome> {
	try {
		signal?.throwIfAborted();
		return { ok: true, text: contentText((await run()).content) };
	} catch (error) {
		signal?.throwIfAborted();
		return { ok: false, text: `${visibleControls(label)}: refused - ${errorMessage(error)}` };
	}
}

/**
 * Runs one entry of a batch and appends its row. A cancel after an entry started or applied throws `BatchAbortedError`
 * with what applied so far; a cancel before anything started propagates as is.
 */
export async function appendWrite(
	rows: EntryOutcome[],
	operation: string,
	requested: number,
	label: string,
	run: () => EntryResult | Promise<EntryResult>,
	signal?: AbortSignal,
): Promise<void> {
	let started = false;
	try {
		rows.push(
			await attemptWrite(
				label,
				() => {
					started = true;
					return run();
				},
				signal,
			),
		);
	} catch (error) {
		if (!signal?.aborted || (!rows.length && !started)) throw error;
		const outcomes: BatchOutcome[] = rows.map((row, index) => ({
			index,
			status: row.ok ? "applied" : "refused",
			text: row.text,
		}));
		if (started)
			outcomes.push({
				index: rows.length,
				status: "unknown",
				text: `${visibleControls(label)}: outcome unknown; inspect stored state before retrying.`,
			});
		throw new BatchAbortedError(operation, requested, outcomes);
	}
}

/** The head line and one line per entry. When every entry was refused nothing changed: that is an error result, not a success. */
export function batchSummary(
	verb: string,
	rows: readonly EntryOutcome[],
	condense?: (applied: string[]) => string,
): BatchResult {
	const applied = rows.filter((row) => row.ok).length;
	const failed = applied < rows.length ? `; ${rows.length - applied} refused` : "";
	// `condense` turns the applied rows' texts into one tail after the count, so a long batch does not echo every entry.
	const head =
		condense && applied > 0
			? `${verb} ${applied} of ${rows.length}: ${condense(rows.filter((row) => row.ok).map((row) => row.text))}${failed}.`
			: `${verb} ${applied} of ${rows.length}${failed}.`;
	const text = [head, ...rows.filter((row) => !condense || !row.ok).map((row) => row.text)].join("\n");
	if (rows.length > 0 && applied === 0) throw new Error(text);
	return textResult(text);
}

/**
 * Any tool's write batch: each entry runs `one` in order, labelled by `label` when refused; the rest still run. The reply
 * is `verb N of M.` and one line per entry; when every entry is refused it is an error. A cancel mid-batch reports
 * which entries applied (`operation` names the batch in that receipt).
 */
export async function batchEntries<T>(
	entries: readonly T[],
	label: (entry: T, index: number) => string,
	one: (entry: T) => EntryResult | Promise<EntryResult>,
	options: { operation: string; verb: string; signal?: AbortSignal; condense?: (applied: string[]) => string },
): Promise<BatchResult> {
	const rows: EntryOutcome[] = [];
	for (const [index, entry] of entries.entries())
		await appendWrite(rows, options.operation, entries.length, label(entry, index), () => one(entry), options.signal);
	return batchSummary(options.verb, rows, options.condense);
}
