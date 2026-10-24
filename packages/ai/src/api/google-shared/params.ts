import type { GenerateContentConfig, GenerateContentParameters, ThinkingConfig } from "@google/genai";
import { clampThinkingLevel } from "../../models.ts";
import type { Model, SimpleStreamOptions, StreamOptions, ThinkingBudgets, TranscriptContext } from "../../types.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../../utils/text.ts";
import { getCurrentTools, getInitialSystemMessage } from "../../utils/transcript.ts";
import { convertMessages } from "./messages.ts";
import {
	type GoogleApiThinkingLevel,
	type GoogleApiType,
	getDisabledGoogleThinkingConfig,
	type ResolvedGoogleThinkingLevel,
	resolveGoogleThinkingLevel,
	toGoogleSdkThinkingLevel,
	toGoogleThinkingLevel,
	usesGoogleThinkingLevel,
} from "./thinking.ts";
import { convertTools, resolveGoogleFunctionCallingMode, supportsGoogleStrictToolSampling } from "./tools.ts";

interface GoogleThinkingOptions {
	enabled: boolean;
	budgetTokens?: number; // -1 for dynamic, 0 to disable
	level?: GoogleApiThinkingLevel;
}

/** Stream options shared by the Google Generative AI and Vertex adapters. */
export interface GoogleBaseOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: GoogleThinkingOptions;
}

export function buildGoogleParams<T extends GoogleApiType>(
	model: Model<T>,
	context: TranscriptContext,
	options: GoogleBaseOptions = {},
): GenerateContentParameters {
	const contents = convertMessages(model, context);
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const currentTools = getCurrentTools(context.messages);

	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
	const functionCallingMode =
		currentTools.length > 0
			? resolveGoogleFunctionCallingMode(currentTools, options.toolChoice, supportsStrictMode)
			: undefined;
	const systemInstruction = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(systemInstruction && { systemInstruction: sanitizeSurrogates(systemInstruction) }),
		...(currentTools.length > 0 && {
			tools: convertTools(currentTools, false, supportsStrictMode),
		}),
		...(functionCallingMode !== undefined && {
			toolConfig: { functionCallingConfig: { mode: functionCallingMode } },
		}),
	};

	if (options.thinking?.enabled && model.reasoning) {
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(options.thinking.level);
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = thinkingConfig;
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		config.thinkingConfig = getDisabledGoogleThinkingConfig(model);
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	return { model: model.id, contents, config };
}

const GOOGLE_BUDGETS_2_5_PRO: Record<ResolvedGoogleThinkingLevel, number> = {
	minimal: 128,
	low: 2048,
	medium: 8192,
	high: 32768,
};
const GOOGLE_BUDGETS_2_5_FLASH_LITE: Record<ResolvedGoogleThinkingLevel, number> = {
	minimal: 512,
	low: 2048,
	medium: 8192,
	high: 24576,
};
const GOOGLE_BUDGETS_2_5_FLASH: Record<ResolvedGoogleThinkingLevel, number> = {
	minimal: 128,
	low: 2048,
	medium: 8192,
	high: 24576,
};

function getGoogleBudget<T extends GoogleApiType>(
	model: Model<T>,
	level: ResolvedGoogleThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	if (customBudgets?.[level] !== undefined) {
		return customBudgets[level];
	}
	if (model.id.includes("2.5-pro")) return GOOGLE_BUDGETS_2_5_PRO[level];
	if (model.id.includes("2.5-flash-lite")) return GOOGLE_BUDGETS_2_5_FLASH_LITE[level];
	if (model.id.includes("2.5-flash")) return GOOGLE_BUDGETS_2_5_FLASH[level];
	return -1;
}

/** Map `SimpleStreamOptions.reasoning` to the adapter-level `thinking` option. */
export function resolveGoogleSimpleThinking<T extends GoogleApiType>(
	model: Model<T>,
	options?: SimpleStreamOptions,
): GoogleThinkingOptions {
	if (!options?.reasoning) return { enabled: false };

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	if (clampedReasoning === "off") return { enabled: false };
	const resolvedLevel = resolveGoogleThinkingLevel(model, clampedReasoning);

	if (usesGoogleThinkingLevel(model)) {
		return { enabled: true, level: toGoogleThinkingLevel(resolvedLevel) };
	}
	return { enabled: true, budgetTokens: getGoogleBudget(model, resolvedLevel, options.thinkingBudgets) };
}
