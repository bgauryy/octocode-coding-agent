import type { CompactionResult } from "./compaction.ts";

export interface NativeCompactionResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}
