import { compactionThresholdTokens } from "./settings.ts";
import type { CompactionSettings } from "./compaction.ts";

/** First token count at which the loop stops at a step boundary: `compactionThresholdTokens`, the one first point. */
export function compactionStopTokens(contextWindow: number, settings: CompactionSettings): number {
	return compactionThresholdTokens(contextWindow, settings);
}

/** Whether `contextTokens` reached the stop of `compactionStopTokens`. A window of 0 or less is unknown. */
export function shouldStopForCompaction(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
): boolean {
	if (!settings.enabled || !(contextWindow > 0)) return false;
	const stop = compactionStopTokens(contextWindow, settings);
	return stop > 0 && contextTokens >= stop;
}
