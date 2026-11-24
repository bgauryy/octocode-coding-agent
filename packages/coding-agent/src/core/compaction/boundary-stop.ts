import { compactionThresholdTokens } from "./settings.ts";
import type { CompactionSettings } from "./compaction.ts";

/** In the new event loop, compact at a step boundary shortly before the usual compaction limit.
 * Context-usage notices are configured separately by monitor.contextBands. */
const COMPACTION_STOP_AT = 0.95;

/** First token count at which the new loop stops at a step boundary. */
export function compactionStopTokens(contextWindow: number, settings: CompactionSettings): number {
	return Math.ceil(COMPACTION_STOP_AT * compactionThresholdTokens(contextWindow, settings));
}

/** Whether `contextTokens` reached the hard stop: `STOP_AT` of the limit. A window of 0 or less is unknown. */
export function shouldStopForCompaction(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
): boolean {
	if (!settings.enabled || !(contextWindow > 0)) return false;
	const stop = compactionStopTokens(contextWindow, settings);
	return stop > 0 && contextTokens >= stop;
}
