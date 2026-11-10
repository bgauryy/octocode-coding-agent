import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { StreamOptions } from "../../types.ts";
import type { OpenAIResponsesCacheFields } from "../openai-prompt-cache.ts";

export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

// Keep evolving cache fields independent of the SDK's release cadence. Other SDK imports are type-only.
export type ResponsesRequest = Omit<ResponseCreateParamsStreaming, "prompt_cache_options"> & {
	prompt_cache_options?: OpenAIResponsesCacheFields["prompt_cache_options"];
};
