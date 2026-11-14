import type { ToolCallPhases } from "@octocodeai/octocode-ai";
/** Whole milliseconds since `start` (a `performance.now()` reading). */
export function sinceMs(start: number): number {
	return Math.round(performance.now() - start);
}

/** The phases that took a millisecond or more, or undefined when none did. */
export function toolCallPhases(phases: ToolCallPhases): ToolCallPhases | undefined {
	const kept: ToolCallPhases = {};
	for (const key of ["prepareMs", "queuedMs", "finalizeMs", "heldMs"] as const) {
		const value = phases[key];
		if (value !== undefined && value >= 1) kept[key] = value;
	}
	if (phases.early) kept.early = true;
	return Object.keys(kept).length > 0 ? kept : undefined;
}
