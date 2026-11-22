import type { Api, Model } from "../../src/types.ts";
import { applyThinkingLevelRules, getEffortThinkingLevelMap } from "../../src/utils/thinking-level-rules.ts";
import {
	isAnthropicAdaptiveThinkingModel,
	isAnthropicTemperatureUnsupportedModel,
	mergeAnthropicMessagesCompat,
} from "./anthropic.ts";
import { detectOpenAICompletionsCompat } from "./openai-compat.ts";
import { getModelKey, mergeThinkingLevelMap, modelsDevReasoningOptions } from "./thinking-levels.ts";

/** Thinking-level metadata applied to every generated chat model. */

function supportsDirectReasoningEffort(model: Model<Api>): boolean {
	if (model.api === "anthropic-messages") {
		return (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking === true;
	}
	if (model.api === "openai-responses" || model.api === "azure-openai-responses") {
		return true;
	}
	if (model.api !== "openai-completions") return false;

	const compat = {
		...detectOpenAICompletionsCompat(model as Model<"openai-completions">),
		...model.compat,
	};
	return compat.thinkingFormat === "openai" && compat.supportsReasoningEffort;
}

export function applyModelsDevReasoningOptionMetadata(model: Model<Api>): void {
	const reasoningOptions = modelsDevReasoningOptions.get(getModelKey(model));
	if (!reasoningOptions || !supportsDirectReasoningEffort(model)) return;
	const thinkingLevelMap = getEffortThinkingLevelMap(reasoningOptions);
	if (thinkingLevelMap) mergeThinkingLevelMap(model, thinkingLevelMap);
}

/**
 * The Anthropic compat flags first (the rules read `forceAdaptiveThinking`), the id and provider rules the host shares
 * (`applyThinkingLevelRules`), then the toggle options only the models.dev snapshot knows.
 */
export function applyThinkingLevelMetadata(model: Model<any>): void {
	if (model.api === "anthropic-messages" && isAnthropicAdaptiveThinkingModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { forceAdaptiveThinking: true });
	}
	if (model.api === "anthropic-messages" && isAnthropicTemperatureUnsupportedModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { supportsTemperature: false });
	}
	applyThinkingLevelRules(model);
	if (
		model.provider === "fireworks" &&
		model.api === "anthropic-messages" &&
		(model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking &&
		modelsDevReasoningOptions.get(getModelKey(model))?.some((option) => option.type === "toggle")
	) {
		mergeThinkingLevelMap(model, { off: "none" });
	}
}
