import { inputRoomTokens } from "./settings.ts";
import type { CompactionSettings } from "./compaction.ts";

/** In the new event loop, compact at a step boundary shortly before the usual compaction limit.
 * Context-usage notices are configured separately by monitor.contextBands. */
const COMPACTION_STOP_AT = 0.95;

/** Whether `contextTokens` reached the hard stop: `STOP_AT` of the limit. A window of 0 or less is unknown. */
export function shouldStopForCompaction(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
): boolean {
	if (!settings.enabled || !(contextWindow > 0)) return false;
	const limit = inputRoomTokens(contextWindow, settings.reserveTokens, settings.maxInputTokens);
	return limit > 0 && contextTokens >= COMPACTION_STOP_AT * limit;
}
