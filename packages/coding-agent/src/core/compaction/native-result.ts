import type { CompactionResult } from "./compaction.ts";

export interface NativeCompactionResult {
	cancel?: boolean;
	/** With `cancel`: the compaction failed (not the user's cancel). It counts toward the automatic failure limit and its text is the error. */
	failure?: string;
	compaction?: CompactionResult;
}
