/** Longest tool-call id Anthropic, Bedrock, Gemini and the OpenAI Responses API accept. */
export const DEFAULT_TOOL_CALL_ID_MAX_LENGTH = 64;

/**
 * Makes `id` valid for the providers that accept only `[a-zA-Z0-9_-]` and at most `maxLength` characters. The one
 * sanitizer every adapter uses; each passes its own limit. `trimTrailingUnderscores` also drops a trailing run of
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
