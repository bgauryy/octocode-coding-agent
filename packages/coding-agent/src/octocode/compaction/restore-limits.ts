import { scaledByWindow } from "../shared/window-scale.ts";

/** What a restore after a compaction may read back (`restore.ts` describes the flow). */

/** At most this many files come back (the few the work centered on; more would refill the context the summary freed)... */
export const RESTORE_MAX_FILES = 5;
/** ...a file up to this many characters (about 3.2k tokens at `CHARS_PER_TOKEN`) comes back whole; a longer one shows its outline (at most `RESTORE_OUTLINE_CHARS`), or, with no declaration to list, whole lines from the last range worked on, with a note... */
export const RESTORE_FILE_CHARS = 8_000;
/** ...an outline takes up to this many characters (the declarations of a file that did not fit whole)... */
export const RESTORE_OUTLINE_CHARS = 4_000;
/** ...and all of them together up to this many (about 8k tokens at `CHARS_PER_TOKEN`), but at most `RESTORE_SHARE` of the window left after Octocode's reserve (`windowBudget`)... */
export const RESTORE_TOTAL_CHARS = 20_000;
/** ...the share of that window, so a small model is not refilled to its threshold. */
export const RESTORE_SHARE = 0.1;
/** The restore limits above for `contextWindow`: the floors, grown with a larger window (`windowScale`). */
export function restoreLimits(contextWindow?: number) {
	return {
		maxFiles: scaledByWindow(RESTORE_MAX_FILES, contextWindow),
		fileChars: scaledByWindow(RESTORE_FILE_CHARS, contextWindow),
		outlineChars: scaledByWindow(RESTORE_OUTLINE_CHARS, contextWindow),
		totalChars: scaledByWindow(RESTORE_TOTAL_CHARS, contextWindow),
	};
}
export type RestoreLimits = ReturnType<typeof restoreLimits>;
