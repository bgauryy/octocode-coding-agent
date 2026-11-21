import type { AnthropicOptions } from "../api/anthropic-messages.ts";
import type { AzureOpenAIResponsesOptions } from "../api/azure-openai-responses.ts";
import type { BedrockOptions } from "../api/bedrock-converse-stream.ts";
import type { GoogleOptions } from "../api/google-generative-ai.ts";
import type { GoogleVertexOptions } from "../api/google-vertex.ts";
import type { MistralOptions } from "../api/mistral-conversations.ts";
import type { OpenAICompletionsOptions } from "../api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "../api/openai-responses.ts";
import type { StreamOptions } from "../types.ts";
import type { Api } from "./ids.ts";

/**
 * Maps known APIs to their full provider-specific stream option types.
 * Type-only imports from API implementation modules are erased at emit, so
 * this is tree-shake safe. `types.ts` must not import this module: the API
 * modules import `types.ts`, so the map lives here and is exported from the
 * package entry point.
 */
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-vertex": GoogleVertexOptions;
	"mistral-conversations": MistralOptions;
	"bedrock-converse-stream": BedrockOptions;
}

/**
 * Full stream options for an API. Known APIs resolve to their concrete option
 * type; custom API strings fall back to the generic shape.
 */
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;
