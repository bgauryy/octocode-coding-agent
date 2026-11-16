/** Gemini thinking wire format chosen from the model ID; free of the Google SDK so capabilities resolve without it. */
import type { Model } from "../../types.ts";

export type GoogleApiType = "google-generative-ai" | "google-vertex";

/**
 * Whether this model uses Gemini's discrete `thinkingLevel` control instead of
 * the token-based `thinkingBudget` control. Supported levels come from the
 * model's `thinkingLevelMap`; this only selects the Google wire format.
 */
/** The `-latest` aliases Google moves to its newest stable models, all Gemini 3 or later since 3 shipped. */
export const GEMINI_LATEST_ALIAS = /^gemini-(?:pro|flash|flash-lite)-latest$/;

export function usesGoogleThinkingLevel<T extends GoogleApiType>(model: Model<T>): boolean {
	const id = model.id.toLowerCase();
	return (
		// Match Gemini 3 Pro/Flash IDs with or without a minor version, such as
		// gemini-3-flash-preview, gemini-3.1-pro-preview, and gemini-3.8-flash.
		/gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) ||
		// Match Gemini 4 and later, such as gemini-4-argon (#10890).
		/gemini-(?:[4-9]|[1-9]\d)/.test(id) ||
		GEMINI_LATEST_ALIAS.test(id) ||
		// Match both hosted Gemma 4 naming forms: gemma-4-* and gemma4-*.
		/gemma-?4/.test(id)
	);
}
