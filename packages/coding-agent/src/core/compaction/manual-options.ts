import type { FocusSource } from "./summary-focus.ts";

/** Who asked for a manual compaction: the user (`/compact`, RPC, SDK) or the agent itself (its `compact` tool). */
export type CompactionRequester = FocusSource;

/** Additional focus applies only to this manual compaction. */
export interface ManualCompactionOptions {
	customInstructions?: string;
	/** Default `user`. The agent's request may reuse the summary written ahead of the threshold, and its focus is labelled as its own. */
	requestedBy?: CompactionRequester;
}
export const MAX_COMPACTION_INSTRUCTIONS = 16_000;
export function validateCompactionInstructions(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > MAX_COMPACTION_INSTRUCTIONS)
		throw new Error(`Compaction instructions must be text of at most ${MAX_COMPACTION_INSTRUCTIONS} characters.`);
	return value.trim() ? value : undefined;
}
