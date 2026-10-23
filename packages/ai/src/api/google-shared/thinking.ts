import { ThinkingLevel as GoogleSdkThinkingLevel, type ThinkingConfig } from "@google/genai";
import { clampThinkingLevel } from "../../models.ts";
import type { Model, ThinkingLevel } from "../../types.ts";

export type GoogleApiType = "google-generative-ai" | "google-vertex";

/**
 * Thinking level for Gemini 3 models.
 * Mirrors Google's ThinkingLevel enum values.
 */
export type GoogleApiThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
export type ResolvedGoogleThinkingLevel = Exclude<ThinkingLevel, "xhigh" | "max">;

const GOOGLE_SDK_THINKING_LEVEL_MAP: Record<GoogleApiThinkingLevel, GoogleSdkThinkingLevel> = {
	THINKING_LEVEL_UNSPECIFIED: GoogleSdkThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
	MINIMAL: GoogleSdkThinkingLevel.MINIMAL,
	LOW: GoogleSdkThinkingLevel.LOW,
	MEDIUM: GoogleSdkThinkingLevel.MEDIUM,
	HIGH: GoogleSdkThinkingLevel.HIGH,
};

/** Resolve a supported pi level or model-specific Google mapping to a standard Google level. */
export function resolveGoogleThinkingLevel<T extends GoogleApiType>(
	model: Model<T>,
	level: ThinkingLevel,
): ResolvedGoogleThinkingLevel {
	const mapped = model.thinkingLevelMap?.[level];
	const resolvedLevel = typeof mapped === "string" ? mapped.toLowerCase() : level;
	switch (resolvedLevel) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
			return resolvedLevel;
		default:
			throw new Error(
				`Unsupported Google thinking level mapping for ${model.provider}/${model.id}: ${level} -> ${String(mapped)}`,
			);
	}
}

/**
 * Whether this model uses Gemini's discrete `thinkingLevel` control instead of
 * the token-based `thinkingBudget` control. Supported levels come from the
 * model's `thinkingLevelMap`; this only selects the Google wire format.
 */
export function usesGoogleThinkingLevel<T extends GoogleApiType>(model: Model<T>): boolean {
	const id = model.id.toLowerCase();
	return (
		// Match Gemini 3 Pro/Flash IDs with or without a minor version, such as
		// gemini-3-flash-preview, gemini-3.1-pro-preview, and gemini-3.8-flash.
		/gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) ||
		// Match Gemini 4 and later, such as gemini-4-argon (#10890).
		/gemini-(?:[4-9]|[1-9]\d)/.test(id) ||
		id === "gemini-flash-latest" ||
		id === "gemini-flash-lite-latest" ||
		// Match both hosted Gemma 4 naming forms: gemma-4-* and gemma4-*.
		/gemma-?4/.test(id)
	);
}

export function toGoogleThinkingLevel(level: ResolvedGoogleThinkingLevel): GoogleApiThinkingLevel {
	switch (level) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
	}
}

export function toGoogleSdkThinkingLevel(level: GoogleApiThinkingLevel): GoogleSdkThinkingLevel {
	return GOOGLE_SDK_THINKING_LEVEL_MAP[level];
}

export function getDisabledGoogleThinkingConfig<T extends GoogleApiType>(model: Model<T>): ThinkingConfig {
	if (!usesGoogleThinkingLevel(model)) return { thinkingBudget: 0 };

	const fallback = clampThinkingLevel(model, "off");
	if (fallback === "off") return { thinkingBudget: 0 };

	const resolvedLevel = resolveGoogleThinkingLevel(model, fallback);
	const apiLevel = toGoogleThinkingLevel(resolvedLevel);
	return { thinkingLevel: toGoogleSdkThinkingLevel(apiLevel) };
}
