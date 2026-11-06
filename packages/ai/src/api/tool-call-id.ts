import { fastHash } from "../utils/hash.ts";

/** Longest tool-call id Anthropic, Bedrock, Gemini and the OpenAI Responses API accept. */
export const DEFAULT_TOOL_CALL_ID_MAX_LENGTH = 64;

/**
 * Makes `id` valid for the providers that accept only `[a-zA-Z0-9_-]` and at most `maxLength` characters, cutting
 * what does not fit; each adapter passes its own limit, and `fitToolCallId` replaces it where two cut ids could collide. `trimTrailingUnderscores` also drops a trailing run of
 * `_`, for ids whose halves are rejoined by the caller. Mistral's alphabet differs, so it keeps its own derivation.
 */
export function sanitizeToolCallId(
	id: string,
	maxLength: number = DEFAULT_TOOL_CALL_ID_MAX_LENGTH,
	options?: { trimTrailingUnderscores?: boolean },
): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLength);
	return options?.trimTrailingUnderscores ? sanitized.replace(/_+$/, "") : sanitized;
}

/**
 * `sanitizeToolCallId` for another model's id replayed to this provider: an id longer than `maxLength` keeps its start
 * and ends with a hash of the whole original id, so two ids that share their first `maxLength` characters (parallel
 * calls GitHub Copilot gives one call id) stay distinct. Deterministic, so a replayed transcript keeps its bytes.
 */
export function fitToolCallId(id: string, maxLength: number = DEFAULT_TOOL_CALL_ID_MAX_LENGTH): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (sanitized.length <= maxLength) return sanitized;
	const hash = fastHash(id);
	if (hash.length + 1 >= maxLength) return hash.slice(0, maxLength);
	return `${sanitized.slice(0, maxLength - hash.length - 1)}_${hash}`;
}
