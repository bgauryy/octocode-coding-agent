import type { Model, OpenAIResponsesCompat, ProviderHeaders } from "../../types.ts";
import type { OpenAIResponsesOptions } from "./types.ts";

/**
 * OpenAI API keys start with `sk-`; a different credential sent directly to OpenAI
 * is a Sign in with ChatGPT access token.
 */
export function isChatGPTSignIn(model: Model<"openai-responses">, apiKey: string | undefined): boolean {
	return (
		model.provider === "openai" &&
		model.baseUrl === "https://api.openai.com/v1" &&
		apiKey !== undefined &&
		!apiKey.startsWith("sk-")
	);
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

export function getClientApiKey(
	provider: string,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

function detectSessionAffinityFormat(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">) {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}

export function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		supportsLongCacheRetention:
			model.compat?.supportsLongCacheRetention ??
			(model.provider === "openai" || new URL(model.baseUrl).hostname === "api.openai.com"),
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
		supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
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
