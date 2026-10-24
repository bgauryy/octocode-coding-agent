/** Additional focus applies only to this manual compaction. */
export interface ManualCompactionOptions {
	customInstructions?: string;
}
export const MAX_COMPACTION_INSTRUCTIONS = 16_000;
export function validateCompactionInstructions(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > MAX_COMPACTION_INSTRUCTIONS)
		throw new Error(`Compaction instructions must be text of at most ${MAX_COMPACTION_INSTRUCTIONS} characters.`);
	return value.trim() ? value : undefined;
}
