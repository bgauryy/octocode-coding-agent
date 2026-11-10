import type {
	AnthropicMessagesCompat,
	BedrockCompat,
	GoogleCompat,
	MistralConversationsCompat,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "../providers/compat-schema.ts";
import type {
	ModelCost,
	ModelInputLimits,
	ModelInputModality,
	ModelPromptCache,
	ModelThinkingLevel,
	ThinkingLevelMap,
} from "../providers/model-schema.ts";
import type { Api, ClassifierApi, ImageApi, ProviderId } from "./ids.ts";

export type SamplingParams = Record<string, unknown>;
export type SamplingParamsByThinkingLevel = Partial<Record<ModelThinkingLevel, SamplingParams>>;

/** Fields shared by every catalog entry, regardless of what you can do with it. */
export interface BaseModel<TApi extends string> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	input: ModelInputModality[];
	/** Provider input limits and cache-safe preprocessing metadata. */
	inputLimits?: ModelInputLimits;
	cost: ModelCost;
	headers?: Record<string, string>;
}

/** Chat model: usable with `stream()` and friends. */
export interface Model<TApi extends Api> extends BaseModel<TApi> {
	/**
	 * Optional: chat is the default model type, so models without `type` are chat
	 * models. Narrow mixed model lists with `isModelType()` instead of comparing
	 * `type` directly.
	 */
	type?: "chat";
	reasoning: boolean;
	/**
	 * Maps Octocode thinking levels to provider/model-specific values.
	 * Missing keys use provider defaults. null marks a level as unsupported.
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** Prompt cache lifetimes per retention tier. Unset when the provider's cache behavior is unknown. */
	promptCache?: ModelPromptCache;
	contextWindow: number;
	maxTokens: number;
	/** Default sampling parameters for this model. See {@link StreamOptions.samplingParams}; per-request keys override these. */
	samplingParams?: SamplingParams;
	/** Sampling parameter overrides selected by the effective Octocode thinking level. */
	samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
	/** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: TApi extends "bedrock-converse-stream"
					? BedrockCompat
					: TApi extends "mistral-conversations"
						? MistralConversationsCompat
						: TApi extends "google-generative-ai" | "google-vertex"
							? GoogleCompat
							: never;
}

/** Image-generation model: usable with `generateImages()` only. */
export interface ImageModel<TApi extends ImageApi> extends BaseModel<TApi> {
	type: "image";
	/** Output modalities. Always includes `"image"`; `"text"` means the model can also return text blocks. */
	output: ("text" | "image")[];
}

/** Structured classifier model: usable with `classify()` only. */
export interface ClassifierModel<TApi extends ClassifierApi> extends BaseModel<TApi> {
	type: "classifier";
	contextWindow: number;
}

export interface ModelTypeMap {
	chat: Model<Api>;
	image: ImageModel<ImageApi>;
	classifier: ClassifierModel<ClassifierApi>;
}

/** What a catalog entry is for. Decides which `Models` operation accepts it. */
export type ModelType = keyof ModelTypeMap;

/** Anything a provider can list. Narrow with `isModelType()`. */
export type AnyModel = ModelTypeMap[ModelType];
