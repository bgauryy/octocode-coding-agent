import type { Api, Model, OpenAIResponsesCompat } from "../types.ts";

// Verified 2026-11-08 against the model families and aliases documented at (GPT-5.6 and later):
// https://developers.openai.com/api/docs/guides/prompt-caching
// https://developers.openai.com/api/docs/pricing
const OPENAI_EXPLICIT_CACHE_MODELS = new Set([
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.6-cyber",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
	"gpt-daybreak-blue-latest",
	"gpt-daybreak-red-latest",
]);

/** Fill missing catalog metadata without deriving protocol support from pricing. Explicit metadata wins. */
export function withCacheCapabilities<T extends Model<Api>>(model: T): T {
	if (model.provider !== "openai" || model.api !== "openai-responses") return model;
	if (new URL(model.baseUrl).origin !== "https://api.openai.com" || !OPENAI_EXPLICIT_CACHE_MODELS.has(model.id))
		return model;
	return {
		...model,
		compat: { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true, ...model.compat },
	};
}

/** Direct-provider capabilities must be re-declared when a configured endpoint changes. */
export function withCacheEndpoint<T extends Model<Api>>(model: T, baseUrl: string): T {
	if (model.baseUrl === baseUrl) return model;
	if (model.provider !== "openai" && model.provider !== "anthropic") return { ...model, baseUrl };
	const compat = { ...model.compat, supportsLongCacheRetention: false };
	if (model.api === "openai-responses") (compat as OpenAIResponsesCompat).supportsExplicitPromptCacheMode = false;
	return { ...model, baseUrl, compat, promptCache: undefined };
}
