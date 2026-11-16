import { clampThinkingLevel } from "../../models/model-helpers.ts";
import type { Model, ThinkingLevel } from "../../types.ts";
import { type GoogleApiType, usesGoogleThinkingLevel } from "./google-thinking-format.ts";

export type { GoogleApiType };

/**
 * Thinking level for Gemini 3 models.
 * Mirrors Google's ThinkingLevel enum values.
 */
export type GoogleApiThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
export type ResolvedGoogleThinkingLevel = Exclude<ThinkingLevel, "xhigh" | "max">;

interface ThinkingConfig {
	thinkingBudget?: number;
	thinkingLevel?: GoogleApiThinkingLevel;
}

/** Resolve a supported Octocode level or model-specific Google mapping to a standard Google level. */
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

export function getDisabledGoogleThinkingConfig<T extends GoogleApiType>(model: Model<T>): ThinkingConfig {
	if (!usesGoogleThinkingLevel(model)) return disabledGoogleThinkingBudget(model);

	const fallback = clampThinkingLevel(model, "off");
	if (fallback === "off") return { thinkingBudget: 0 };

	const resolvedLevel = resolveGoogleThinkingLevel(model, fallback);
	const apiLevel = toGoogleThinkingLevel(resolvedLevel);
	return { thinkingLevel: apiLevel };
}

/** Budget-path models: a numeric `off` mapping is the smallest budget they accept; `null` means thinking cannot be disabled. */
function disabledGoogleThinkingBudget<T extends GoogleApiType>(model: Model<T>): ThinkingConfig {
	const off = model.thinkingLevelMap?.off;
	if (off === null) return {};
	const budget = off === undefined ? Number.NaN : Number(off);
	return { thinkingBudget: Number.isInteger(budget) && budget >= 0 ? budget : 0 };
}
