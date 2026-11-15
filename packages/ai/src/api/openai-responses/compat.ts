import type { Model, OpenAIResponsesCompat } from "../../types.ts";
import { isOpenRouterModel } from "../../utils/provider-host.ts";
import type { OpenAIResponsesOptions } from "./types.ts";

/**
 * OpenAI API keys start with `sk-`; a different credential sent directly to OpenAI
 * is a Sign in with ChatGPT access token.
 */
export function isChatGPTSignIn(model: Model<"openai-responses">, apiKey: string | undefined): boolean {
	return (
		model.provider === "openai" &&
		model.baseUrl.replace(/\/+$/, "") === "https://api.openai.com/v1" &&
		apiKey !== undefined &&
		!apiKey.startsWith("sk-")
	);
}

function detectSessionAffinityFormat(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">) {
	return isOpenRouterModel(model) ? "openrouter" : "openai";
}

function baseUrlHostname(model: Pick<Model<"openai-responses">, "id" | "provider" | "baseUrl">): string {
	try {
		return new URL(model.baseUrl).hostname;
	} catch {
		throw new Error(
			`Invalid baseUrl for model "${model.provider}/${model.id}": ${JSON.stringify(model.baseUrl)} is not an absolute URL`,
		);
	}
}

export function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		// OpenAI documents the long tier per model: 12h in explicit mode (GPT-5.6 and later), 24h retention for a list the
		// catalog carries as this flag. A model without the flag stays on the default tier.
		supportsLongCacheRetention:
			model.compat?.supportsLongCacheRetention ??
			((model.provider === "openai" || baseUrlHostname(model) === "api.openai.com") &&
				model.compat?.supportsExplicitPromptCacheMode === true),
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
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
	model: Model<"openai-responses">,
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
