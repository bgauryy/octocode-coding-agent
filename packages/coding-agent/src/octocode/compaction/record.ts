import type { SetupPick } from "../../core/features/index.ts";
import { isStaleSessionError } from "../shared/util.ts";

/**
 * Compaction decisions a user sees only as a notice, kept in the session so the history shows them later: which
 * summary Octocode wrote when Octocode's did not run, why an automatic compaction was refused, and why a model switch
 * compacted first. A custom session entry is never sent to the model. (A summary Octocode wrote names its own method
 * and any fallback reason in the compaction entry's `details`, `summary.ts`.)
 */

/** The session entry type of a compaction note; `data` is `{ kind, reason }`. */
export const COMPACTION_NOTE_TYPE = "octocode-compaction-note";

type CompactionNoteKind =
	/** Octocode's summary failed or could not start, so Octocode wrote its default summary. */
	| "default-summary"
	/** The thrash breaker refused an automatic compaction. */
	| "thrash-stop"
	/** A model switch to a smaller window compacted first, on the previous model. */
	| "downshift"
	/** The compaction succeeded but its messages could not be archived. */
	| "archive-failed"
	/** Complete checkpoint content could not be persisted, so compaction was cancelled. */
	| "checkpoint-not-saved"
	/** The summary requested ahead of the threshold (`early-summary.ts`): requested, ready, or why it cannot be used. */
	| "early-summary"
	/** The decision at a finished backlog item (`on-done.ts`): its measures and whether it compacted. */
	| "done-compaction";

/** Appends a compaction note to the session; a session replaced meanwhile (a stale `api`) records nothing. */
export function recordCompactionNote(
	api: SetupPick<"session", "appendEntry">,
	kind: CompactionNoteKind,
	reason: string,
	/** Measures a reader of the history can use; written beside `kind` and `reason`. */
	data: Record<string, unknown> = {},
): void {
	try {
		api.session.appendEntry(COMPACTION_NOTE_TYPE, { ...data, kind, reason });
	} catch (error) {
		if (!isStaleSessionError(error)) throw error;
	}
}
