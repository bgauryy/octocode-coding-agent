import type { Api, Model, OpenAICompletionsCompat } from "../../src/types.ts";
import { getEffortThinkingLevelMap, type ModelsDevReasoningOption } from "../models-dev-reasoning-options.ts";
import {
	TOGETHER_BASE_COMPAT,
	TOGETHER_DEEPSEEK_V4_THINKING_LEVEL_MAP,
	TOGETHER_FIXED_REASONING_LEVEL_MAP,
	TOGETHER_REASONING_EFFORT_COMPAT,
	TOGETHER_REASONING_EFFORT_LEVEL_MAP,
	TOGETHER_REASONING_EFFORT_MODELS,
	TOGETHER_REASONING_ONLY_MODELS,
	TOGETHER_TOGGLE_REASONING_COMPAT,
	TOGETHER_TOGGLE_REASONING_EFFORT_COMPAT,
	TOGETHER_TOGGLE_REASONING_EFFORT_MODELS,
	TOGETHER_TOGGLE_REASONING_LEVEL_MAP,
} from "./constants.ts";
import type { ModelsDevModel } from "./types.ts";

/** Thinking-level maps and reasoning support by provider family, and the reasoning options models.dev reports. */

export function mergeThinkingLevelMap(model: Model<any>, map: NonNullable<Model<any>["thinkingLevelMap"]>): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

export const modelsDevReasoningOptions = new Map<string, ModelsDevReasoningOption[]>();

export function getModelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}:${model.id}`;
}

export function recordModelsDevReasoningOptions(provider: string, id: string, sourceModel: ModelsDevModel): void {
	if (sourceModel.reasoning_options !== undefined) {
		modelsDevReasoningOptions.set(`${provider}:${id}`, sourceModel.reasoning_options);
	}
}

export function getTogetherCompat(modelId: string, reasoning: boolean): OpenAICompletionsCompat {
	if (!reasoning) return TOGETHER_BASE_COMPAT;
	if (TOGETHER_REASONING_EFFORT_MODELS.has(modelId)) return TOGETHER_REASONING_EFFORT_COMPAT;
	if (TOGETHER_TOGGLE_REASONING_EFFORT_MODELS.has(modelId)) return TOGETHER_TOGGLE_REASONING_EFFORT_COMPAT;
	if (TOGETHER_REASONING_ONLY_MODELS.has(modelId)) return TOGETHER_BASE_COMPAT;
	return TOGETHER_TOGGLE_REASONING_COMPAT;
}

export function getTogetherThinkingLevelMap(
	modelId: string,
	reasoning: boolean,
): NonNullable<Model<any>["thinkingLevelMap"]> | undefined {
	if (!reasoning) return undefined;
	if (TOGETHER_REASONING_EFFORT_MODELS.has(modelId)) return { ...TOGETHER_REASONING_EFFORT_LEVEL_MAP };
	if (TOGETHER_TOGGLE_REASONING_EFFORT_MODELS.has(modelId)) return { ...TOGETHER_DEEPSEEK_V4_THINKING_LEVEL_MAP };
	if (TOGETHER_REASONING_ONLY_MODELS.has(modelId)) return { ...TOGETHER_FIXED_REASONING_LEVEL_MAP };
	return { ...TOGETHER_TOGGLE_REASONING_LEVEL_MAP };
}

export function supportsOpenAiXhigh(modelId: string): boolean {
	return (
		modelId.includes("gpt-5.2") ||
		modelId.includes("gpt-5.3") ||
		modelId.includes("gpt-5.4") ||
		modelId.includes("gpt-5.5") ||
		modelId.includes("gpt-5.6") ||
		modelId.includes("gpt-6")
	);
}

export function supportsOpenAiMax(model: Model<Api>): boolean {
	return (
		(model.id.includes("gpt-5.6") || model.id.includes("gpt-6")) &&
		(model.api === "openai-responses" || model.api === "azure-openai-responses" || model.api === "openai-completions")
	);
}

function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
}

export function getGoogleThinkingLevelMap(
	modelId: string,
	reasoningOptions: readonly ModelsDevReasoningOption[],
): NonNullable<Model<Api>["thinkingLevelMap"]> | undefined {
	const effortMap = getEffortThinkingLevelMap(reasoningOptions);
	if (effortMap) return effortMap;
	if (isGemma4Model(modelId)) {
		return { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" };
	}
	return undefined;
}
