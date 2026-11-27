import { clampThinkingLevel } from "../../models/model-helpers.ts";
import type { Model, SimpleStreamOptions, StreamOptions, ThinkingBudgets } from "../../types.ts";
import {
	type GoogleApiThinkingLevel,
	type GoogleApiType,
	type ResolvedGoogleThinkingLevel,
	resolveGoogleThinkingLevel,
	toGoogleThinkingLevel,
} from "./google-thinking.ts";
import { usesGoogleThinkingLevel } from "./google-thinking-format.ts";

interface GoogleThinkingOptions {
	enabled: boolean;
	budgetTokens?: number;
	level?: GoogleApiThinkingLevel;
}
export interface GoogleBaseOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: GoogleThinkingOptions;
}

const GOOGLE_BUDGETS_BY_FAMILY = {
	pro: { minimal: 128, low: 2048, medium: 8192, high: 32768 },
	"flash-lite": { minimal: 512, low: 2048, medium: 8192, high: 24576 },
	flash: { minimal: 128, low: 2048, medium: 8192, high: 24576 },
} as const satisfies Record<string, Record<ResolvedGoogleThinkingLevel, number>>;

export function getGemini25Family(modelId: string): keyof typeof GOOGLE_BUDGETS_BY_FAMILY | undefined {
	const family = /2\.5-(pro|flash(?:-lite)?)(?![a-z])/.exec(modelId)?.[1];
	return family as keyof typeof GOOGLE_BUDGETS_BY_FAMILY | undefined;
}

function getGoogleBudget<T extends GoogleApiType>(
	model: Model<T>,
	level: ResolvedGoogleThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	if (customBudgets?.[level] !== undefined) return customBudgets[level];
	const family = getGemini25Family(model.id);
	return family ? GOOGLE_BUDGETS_BY_FAMILY[family][level] : -1;
}

export function resolveGoogleSimpleThinking<T extends GoogleApiType>(
	model: Model<T>,
	options?: SimpleStreamOptions,
): GoogleThinkingOptions {
	if (!options?.reasoning) return { enabled: false };
	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	if (clampedReasoning === "off") return { enabled: false };
	const resolvedLevel = resolveGoogleThinkingLevel(model, clampedReasoning);
	if (usesGoogleThinkingLevel(model)) return { enabled: true, level: toGoogleThinkingLevel(resolvedLevel) };
	return { enabled: true, budgetTokens: getGoogleBudget(model, resolvedLevel, options.thinkingBudgets) };
}
