type ResponseServiceTier = "auto" | "default" | "fast" | "flex" | "priority" | "scale" | "ultrafast" | null;
import type { StreamOptions, Usage } from "../../types.ts";

export interface OpenAIResponsesStreamOptions {
	onProviderStreamEvent?: StreamOptions["onProviderStreamEvent"];
	serviceTier?: ResponseServiceTier;
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	resolveServiceTier?: (
		responseServiceTier: ResponseServiceTier | undefined,
		requestServiceTier: ResponseServiceTier | undefined,
	) => ResponseServiceTier | undefined;
	applyServiceTierPricing?: (usage: Usage, serviceTier: ResponseServiceTier | undefined) => void;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	toolSearchResult?: boolean;
}
