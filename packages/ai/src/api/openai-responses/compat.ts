import type { OpenAIResponsesCompat } from "../../types.ts";
import type { ResponsesModel } from "../ai-sdk/responses-model.ts";
import { azureSupportsLongCacheRetention } from "../azure-openai-config.ts";
import { isChatGPTSignIn } from "../../utils/chatgpt-sign-in.ts";
import { hasProviderProfile, isOpenRouterModel } from "../../utils/provider-profile.ts";
import type { OpenAIResponsesOptions } from "./types.ts";

export { isChatGPTSignIn };

function detectSessionAffinityFormat(model: Pick<ResponsesModel, "provider" | "baseUrl">) {
	return isOpenRouterModel(model) ? "openrouter" : "openai";
}

/** A malformed baseUrl fails here with the model named, not later inside a client. */
function assertAbsoluteBaseUrl(model: Pick<ResponsesModel, "id" | "provider" | "baseUrl">): void {
	if (!URL.canParse(model.baseUrl))
		throw new Error(
			`Invalid baseUrl for model "${model.provider}/${model.id}": ${JSON.stringify(model.baseUrl)} is not an absolute URL`,
		);
}

/** OpenAI itself, by profile, provider id or host; a malformed baseUrl fails here, naming the model. */
function isOpenAIEndpoint(model: ResponsesModel): boolean {
	if (model.provider !== "openai") assertAbsoluteBaseUrl(model);
	return hasProviderProfile(model, "openai");
}

export function getCompat(model: ResponsesModel): Required<OpenAIResponsesCompat> {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		// OpenAI documents the long tier per model: 12h in explicit mode (GPT-5.6 and later), 24h retention for a list the
		// catalog carries as this flag. A model without the flag stays on the default tier.
		supportsLongCacheRetention:
			(model.api === "azure-openai-responses" ? azureSupportsLongCacheRetention(model) : undefined) ??
			model.compat?.supportsLongCacheRetention ??
			(isOpenAIEndpoint(model) && model.compat?.supportsExplicitPromptCacheMode === true),
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? model.api === "azure-openai-responses",
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
		supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
		supportsInstructionBreakpoints: model.compat?.supportsInstructionBreakpoints ?? false,
		supportsMidConvoEffort: model.compat?.supportsMidConvoEffort ?? false,
	};
}

/** Effort to send in configuration_update items, or undefined to send it as reasoning.effort. */
export function getConfigurationUpdateEffort(
	model: ResponsesModel,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat>,
): string | undefined {
	if (
		!compat.supportsMidConvoEffort ||
		!options?.reasoningEffort ||
		// Sign in with ChatGPT rejects configuration_update items.
		isChatGPTSignIn(model, options.apiKey)
	) {
		return undefined;
	}
	return model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
}
